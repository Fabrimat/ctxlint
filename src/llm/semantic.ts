import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Config } from '../config/index.js';
import { git, type ChangedFiles } from '../git/diff.js';
import { sectionsOf, type Section } from '../parse/sections.js';
import type { LlmOptions } from '../run.js';
import type { CheckResult, Claim, LlmTotals, Severity } from '../types.js';
import { Budget, callWithBudget } from './budget.js';
import { proposeFix, writePatch } from './fix.js';
import { buildPricing } from './pricing.js';
import {
  createProvider,
  modelFor,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from './provider.js';
import {
  dataBlocks,
  dataRule,
  failureReason,
  FAILURES,
  oneLine,
  verdictSchema,
  type Judgement,
  type SectionInput,
} from './prompt.js';

export { verdictSchema } from './prompt.js';
export type { Judgement, SectionInput, Verdict } from './prompt.js';

/** Output token cap of a judge call (evals use it for their worst-case estimate). */
export const JUDGE_MAX_TOKENS = 1500;

/** Claim kinds whose resolved files are code a section describes. */
const CODE_KINDS: ReadonlySet<Claim['kind']> = new Set(['path', 'symbol', 'snippet', 'custom']);
/** A dependency bump must not select every section that mentions `pnpm build`. */
const DEPENDENCY_FILE =
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/;

/** The judge's prompt: instructions in `system`, the doc and the code as delimited data. */
export function buildPrompt(input: SectionInput): { system: string; prompt: string } {
  const { tag, blocks } = dataBlocks(input, input.body);
  const system = [
    "You check whether one section of a project's documentation is still true of its code.",
    dataRule(tag),
    'The blocks are: the doc section (kind "doc"), source files (kind "code", changed="true" when the file changed since the base) and, when present, the diff of the changed files since the base (kind "diff").',
    'Drift means the doc states behaviour that the code contradicts. Absence of documentation is not drift: a doc that leaves something out is consistent. Trust the code over code comments.',
    'Answer "unsure" when the behaviour depends on code that was not provided.',
    'For "drift": quote is the shortest passage of the doc section that is wrong, copied verbatim; explanation is one short sentence saying what the code does instead; suggestion is the corrected wording of the quote, or null.',
    'For "consistent" and "unsure": quote and suggestion are null and explanation is one short sentence.',
  ].join('\n');
  const prompt = `${blocks}\n\nJudge the doc section against the code.`;
  return { system, prompt };
}

/** 0-based line within `body` where `quote` starts, whitespace-normalised; null when absent. */
export function locateQuote(body: string, quote: string): number | null {
  const q = quote.replace(/\s+/g, ' ').trim();
  if (q === '') return null;
  let norm = '';
  const lines: number[] = [];
  let line = 0;
  let space = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (/\s/.test(ch)) {
      if (!space) {
        norm += ' ';
        lines.push(line);
        space = true;
      }
      if (ch === '\n') line++;
      continue;
    }
    space = false;
    norm += ch;
    lines.push(line);
  }
  const at = norm.indexOf(q);
  return at < 0 ? null : (lines[at] as number);
}

/** Validates a model answer: this is a trust boundary, so anything off becomes `unknown`. */
export function toJudgement(res: LlmResponse<unknown>, input: SectionInput): Judgement {
  if (!res.ok) {
    return { status: 'unknown', reason: failureReason(res) };
  }
  const parsed = verdictSchema.safeParse(res.value);
  if (!parsed.success) return { status: 'unknown', reason: FAILURES.invalid };
  const v = parsed.data;
  if (v.verdict === 'consistent') return { status: 'consistent' };
  const explanation = oneLine(v.explanation);
  if (v.verdict === 'unsure') {
    return {
      status: 'unknown',
      reason: `the model was unsure${explanation ? `: ${explanation}` : ''}`,
    };
  }
  const at = v.quote === null ? null : locateQuote(input.body, v.quote);
  if (v.quote === null || at === null) return { status: 'unknown', reason: 'quote not in section' };
  const suggestion = v.suggestion === null ? null : oneLine(v.suggestion, 1000) || null;
  return {
    status: 'drift',
    quote: oneLine(v.quote, 200),
    line: input.startLine + at,
    explanation: explanation || 'no explanation given',
    suggestion,
  };
}

/** Asks `model` whether the section drifted from the code; never throws. */
export async function judgeSection(
  provider: LlmProvider,
  budget: Budget,
  model: string,
  input: SectionInput,
): Promise<Judgement> {
  const { system, prompt } = buildPrompt(input);
  const res = await callWithBudget(budget, provider, {
    task: 'classify',
    model,
    system,
    prompt,
    schema: verdictSchema,
    maxTokens: JUDGE_MAX_TOKENS,
  });
  return toJudgement(res, input);
}

/** A section to judge and the code files its claims resolve to. */
export interface Selected {
  file: string;
  section: Section;
  /** Sorted; dependency manifests and lockfiles excluded. */
  resolved: string[];
}

/**
 * The sections to judge. `changed` null (scope `all`): every section with resolved files.
 * Otherwise the sections whose claims resolve to changed files, and every section with resolved
 * files in a changed doc.
 */
export function selectSections(
  docs: ReadonlyMap<string, readonly Section[]>,
  results: readonly CheckResult[],
  changed: ReadonlySet<string> | null,
): Selected[] {
  const resolved = new Map<string, Set<string>>();
  const sectionAt = (file: string, line: number): Section | undefined =>
    docs.get(file)?.findLast((s) => s.startLine <= line);
  for (const r of results) {
    if (!CODE_KINDS.has(r.claim.kind) || r.checkId === 'semantic') continue;
    const s = sectionAt(r.claim.file, r.claim.line);
    if (s === undefined) continue;
    const key = `${r.claim.file}\0${s.startLine}`;
    const set = resolved.get(key) ?? new Set<string>();
    for (const f of r.resolvedFiles) if (!DEPENDENCY_FILE.test(f)) set.add(f);
    resolved.set(key, set);
  }
  const out: Selected[] = [];
  for (const [file, sections] of [...docs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (const section of sections) {
      const files = [...(resolved.get(`${file}\0${section.startLine}`) ?? [])].sort();
      if (files.length === 0) continue;
      if (changed === null || changed.has(file) || files.some((f) => changed.has(f))) {
        out.push({ file, section, resolved: files });
      }
    }
  }
  return out;
}

export interface InputLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxSectionBytes: number;
}

/** A resolved file name a check could have returned that is not repo-relative. */
const outside = (f: string): boolean => isAbsolute(f) || f.split(/[\\/]/).includes('..');

/**
 * The judge's input for a selected section, or why it cannot be judged. Nothing is truncated:
 * an oversized section, changed file or diff makes the section unknown.
 */
export async function sectionInput(
  root: string,
  sel: Selected,
  docLines: readonly string[],
  limits: InputLimits,
  base: { sha: string; changed: ReadonlySet<string> } | null,
): Promise<SectionInput | { unknown: string }> {
  const { section } = sel;
  const body = docLines.slice(section.startLine - 1, section.endLine).join('\n');
  const size = Buffer.byteLength(body);
  if (size > limits.maxSectionBytes) {
    return { unknown: `section too large (${size} bytes > llm.maxSectionBytes)` };
  }
  const isChanged = (f: string): boolean => base?.changed.has(f) ?? false;
  const ordered = [
    ...sel.resolved.filter((f) => isChanged(f)),
    ...sel.resolved.filter((f) => !isChanged(f)),
  ]
    .filter((f) => !outside(f))
    .slice(0, limits.maxFiles);
  const files: SectionInput['files'] = [];
  for (const path of ordered) {
    const changed = isChanged(path);
    let buf: Buffer;
    try {
      buf = await readFile(join(root, path));
    } catch {
      continue; // deleted since the base: the diff shows it
    }
    if (buf.length > limits.maxFileBytes) {
      if (changed) {
        return {
          unknown: `changed file ${path} too large (${buf.length} bytes > llm.maxFileBytes)`,
        };
      }
      continue;
    }
    files.push({ path, content: buf.toString('utf8'), changed });
  }
  let diff: string | null = null;
  const changedPaths = ordered.filter(isChanged);
  if (base !== null && changedPaths.length > 0) {
    const out = await git(root, [
      'diff',
      '--no-ext-diff',
      '--relative',
      base.sha,
      '--',
      ...changedPaths,
    ]);
    if (Buffer.byteLength(out) > limits.maxFileBytes) {
      return { unknown: 'diff of the changed files too large (> llm.maxFileBytes)' };
    }
    diff = out === '' ? null : out;
  }
  return {
    file: sel.file,
    path: section.path,
    startLine: section.startLine,
    endLine: section.endLine,
    body,
    files,
    diff,
  };
}

/** Runs `fn` over `items` with at most `n` in flight; results keep the input order. */
export async function pool<T, R>(
  items: readonly T[],
  n: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** `provider` with `after` run on every answer (dump, warnings). */
function tap(
  provider: LlmProvider,
  after: (req: LlmRequest<unknown>, res: LlmResponse<unknown>) => Promise<void>,
): LlmProvider {
  return {
    name: provider.name,
    complete: async <T>(req: LlmRequest<T>): Promise<LlmResponse<T>> => {
      const res = await provider.complete(req);
      await after(req as LlmRequest<unknown>, res);
      return res;
    },
  };
}

export interface SemanticRun {
  root: string;
  config: Config;
  llm: LlmOptions;
  /** Deterministic results of every target doc. */
  results: readonly CheckResult[];
  docFiles: readonly string[];
  base?: { sha: string; diff: ChangedFiles };
  /** `--new-only`: semantic failures are new (the base is not judged). */
  compared: boolean;
  onWarning?: (message: string) => void;
}

/**
 * The semantic drift check of `check --llm`: judges the selected sections with a model and, with
 * `fix`, proposes rewrites. Its results never affect freshness or the deterministic counts.
 */
export async function semantic(run: SemanticRun): Promise<{
  results: CheckResult[];
  totals: LlmTotals;
}> {
  const { config, llm, root } = run;
  const maxCost = llm.maxCost ?? config.llm.maxCost;
  const budget = new Budget(
    maxCost === 'unlimited' ? null : maxCost,
    buildPricing(config.llm.pricing),
  );
  const severity = config.rules.semantic as Severity;
  const changed = run.base?.diff.changed ?? null;
  const scope = llm.scope ?? config.llm.scope;

  let warnedKey = false;
  let dumped = 0;
  const provider = tap(
    llm.provider ?? (await createProvider(config.llm, process.env)),
    async (req, res) => {
      if (!res.ok && res.reason === 'no-key' && !warnedKey) {
        warnedKey = true;
        run.onWarning?.(`--llm: ${oneLine(res.detail)}; the model-judged checks were not run`);
      }
      if (llm.dump !== undefined) {
        const n = ++dumped;
        await mkdir(llm.dump, { recursive: true });
        const { task, model, system, prompt, maxTokens } = req;
        const request = { task, model, system, prompt, maxTokens };
        await writeFile(
          join(llm.dump, `${String(n).padStart(3, '0')}-${req.task}.json`),
          `${JSON.stringify({ request, response: res }, null, 2)}\n`,
        );
      }
    },
  );

  const docs = new Map<string, Section[]>();
  const lines = new Map<string, string[]>();
  for (const file of run.docFiles) {
    const text = await readFile(join(root, file), 'utf8');
    docs.set(file, sectionsOf(text));
    lines.set(file, text.split(/\r?\n/));
  }
  const selected = selectSections(
    docs,
    run.results,
    scope === 'all' ? null : (changed ?? new Set()),
  );
  const model = modelFor(config.llm, 'classify');
  if (model === null && selected.length > 0) {
    run.onWarning?.('--llm: no model configured, set llm.models.classify');
  }
  const base = run.base ? { sha: run.base.sha, changed: run.base.diff.changed } : null;

  const judged = await pool(selected, config.llm.concurrency, async (sel) => {
    const input = await sectionInput(root, sel, lines.get(sel.file) ?? [], config.llm, base);
    if ('unknown' in input) {
      budget.skip();
      return {
        sel,
        input: null,
        judgement: { status: 'unknown', reason: input.unknown } as Judgement,
      };
    }
    if (model === null) {
      budget.skip();
      return {
        sel,
        input,
        judgement: { status: 'unknown', reason: 'no model configured' } as Judgement,
      };
    }
    return { sel, input, judgement: await judgeSection(provider, budget, model, input) };
  });

  const results: CheckResult[] = judged.map(({ sel, judgement }) => {
    const { section } = sel;
    const claim: Claim = {
      kind: 'section',
      value: section.path.join(' > ') || '(preamble)',
      file: sel.file,
      line: section.startLine,
      col: 1,
      section: section.path,
      source: 'prose',
    };
    const base = { claim, checkId: 'semantic', resolvedFiles: sel.resolved };
    if (judgement.status === 'consistent') return { ...base, status: 'pass' };
    if (judgement.status === 'unknown')
      return { ...base, status: 'unknown', reason: judgement.reason };
    const result: CheckResult = {
      ...base,
      status: 'fail',
      finding: {
        file: sel.file,
        line: judgement.line,
        col: 1,
        checkId: 'semantic',
        severity,
        message: `Possible drift: "${judgement.quote}": ${judgement.explanation}`,
        ...(model !== null && { model }),
      },
    };
    if (run.compared) {
      result.baseline = 'new';
      (result.finding as NonNullable<CheckResult['finding']>).introducedBy = changed?.has(sel.file)
        ? 'docs'
        : 'code';
    }
    return result;
  });

  if (llm.fix) {
    const fixModel = modelFor(config.llm, 'fix');
    const drifts = judged.flatMap((j, i) => {
      const finding = results[i]?.finding;
      return j.input !== null && finding !== undefined ? [{ input: j.input, finding }] : [];
    });
    if (fixModel === null && drifts.length > 0) {
      run.onWarning?.('--fix: no model configured, set llm.models.fix');
    }
    if (fixModel !== null) {
      await pool(drifts, config.llm.concurrency, async ({ input, finding }) => {
        const out = await proposeFix(provider, budget, fixModel, input, finding);
        if ('fix' in out) finding.proposedFix = out.fix;
        else {
          run.onWarning?.(
            `--fix: dropped the fix for ${finding.file}:${finding.line}: ${out.reason}`,
          );
        }
      });
    }
    if (llm.patch !== undefined) {
      await writePatch(
        root,
        llm.patch,
        results.flatMap((r) => (r.finding?.proposedFix ? [r.finding] : [])),
        run.onWarning,
      );
    }
  }
  return { results, totals: budget.totals() };
}
