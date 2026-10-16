import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { git } from '../git/diff.js';
import type { Finding } from '../types.js';
import { callWithBudget, type Budget } from './budget.js';
import type { LlmProvider } from './provider.js';
import { dataBlocks, dataRule, toJudgement, type SectionInput } from './semantic.js';

export type ProposedFix = NonNullable<Finding['proposedFix']>;

/** No `.optional()`: OpenAI strict mode. */
export const fixSchema = z.object({
  startLine: z.number().int(),
  endLine: z.number().int(),
  replacement: z.string(),
});

const FIX_MAX_TOKENS = 4000;
const MAX_REPLACEMENT = 4000;

/** The fixer's prompt: the section with line numbers, the finding and the code, as data. */
export function buildFixPrompt(
  input: SectionInput,
  finding: Finding,
): { system: string; prompt: string } {
  const numbered = input.body
    .split('\n')
    .map((l, i) => `${input.startLine + i}\t${l}`)
    .join('\n');
  const { tag, blocks } = dataBlocks(input, numbered, [{ kind: 'finding', text: finding.message }]);
  const system = [
    'You rewrite part of one section of project documentation so that it matches the code.',
    dataRule(tag),
    'The doc block shows each line as its line number, a tab, then the text. The finding block is a possible drift another reviewer reported; the code blocks are the source of truth.',
    'Return startLine and endLine, the smallest range of doc lines (inclusive, numbered as shown) to replace, and replacement, the new text for exactly those lines without line numbers.',
    'Keep the wording, style and Markdown of the doc. Do not add headings, HTML comments, code fences or links that are not already in the section.',
    'When the code does not support a fix, return the original lines unchanged.',
  ].join('\n');
  return { system, prompt: `${blocks}\n\nFix the doc lines the finding is about.` };
}

/** Lines that start a Markdown heading (ATX, or a setext underline). */
const HEADING = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|=+[ \t]*$|-+[ \t]*$)/;
const FENCE = /^ {0,3}(?:`{3,}|~{3,})/;
const URL = /[a-z][a-z0-9+.-]*:\/\/[^\s<>()[\]"'`]+|www\.[^\s<>()[\]"'`]+/gi;
const COMMENT = /<!--[\s\S]*?-->/g;

/**
 * Checks a model's fix against the section (a trust boundary: agents may apply it). Returns the
 * normalised fix, or why it was rejected.
 */
export function validateFix(raw: unknown, input: SectionInput): ProposedFix | string {
  const parsed = fixSchema.safeParse(raw);
  if (!parsed.success) return 'the model answer was not valid';
  const { startLine, endLine } = parsed.data;
  if (startLine > endLine || startLine < input.startLine || endLine > input.endLine) {
    return `lines ${startLine}-${endLine} are outside the section (${input.startLine}-${input.endLine})`;
  }
  const replacement = parsed.data.replacement.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (/(?![\t\n])[\p{Cc}\p{Zl}\p{Zp}]/u.test(replacement)) {
    return 'the replacement has control characters';
  }
  const lines = input.body.split('\n');
  const replaced = lines
    .slice(startLine - input.startLine, endLine - input.startLine + 1)
    .join('\n');
  if (replacement === replaced) return 'the fix changes nothing';
  if (replacement.length > MAX_REPLACEMENT || replacement.length > 2 * replaced.length) {
    return 'the replacement is too long';
  }
  const known = new Set(lines.map((l) => l.trim()));
  const added = replacement.split('\n');
  if (added.some((l) => HEADING.test(l) && !known.has(l.trim()))) return 'the fix adds a heading';
  const fences = (ls: string[]): number => ls.filter((l) => FENCE.test(l)).length;
  if (fences(added) > fences(replaced.split('\n'))) return 'the fix adds a fenced block';
  const comments = replacement.replace(COMMENT, (c) => (input.body.includes(c) ? '' : '<!--'));
  if (/<!--|-->/.test(comments)) return 'the fix adds an HTML comment';
  if ((replacement.match(URL) ?? []).some((u) => !input.body.includes(u))) {
    return 'the fix adds a URL';
  }
  return { startLine, endLine, replacement };
}

/** Asks `model` for a rewrite of the drift `finding`; never throws. Rejected fixes count as skipped. */
export async function proposeFix(
  provider: LlmProvider,
  budget: Budget,
  model: string,
  input: SectionInput,
  finding: Finding,
): Promise<{ fix: ProposedFix } | { reason: string }> {
  const { system, prompt } = buildFixPrompt(input, finding);
  const res = await callWithBudget(budget, provider, {
    task: 'fix',
    model,
    system,
    prompt,
    schema: fixSchema,
    maxTokens: FIX_MAX_TOKENS,
  });
  if (!res.ok) {
    const j = toJudgement(res, input);
    return { reason: j.status === 'unknown' ? j.reason : res.reason };
  }
  const fix = validateFix(res.value, input);
  if (typeof fix === 'string') {
    budget.skip();
    return { reason: fix };
  }
  return { fix };
}

/* ---------- --patch ---------- */

const CONTEXT = 3;

export interface FileFixes {
  /** Path in the patch (relative to the top of the git repository). */
  path: string;
  /** The doc as on disk. */
  text: string;
  fixes: readonly ProposedFix[];
}

interface Hunk {
  path: string;
  oldStart: number;
  oldCount: number;
  newCount: number;
  body: string[];
}

/** `line` (with its own line ending, if any) as a diff line; a missing final newline is marked. */
const diffLine = (mark: string, line: string): string =>
  line.endsWith('\n') ? `${mark}${line}` : `${mark}${line}\n\\ No newline at end of file\n`;

/** Single-file hunks; fixes closer than twice the context share one. Overlapping fixes are dropped. */
export function hunksOf(file: FileFixes): Hunk[] {
  const lines = file.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const eol = file.text.includes('\r\n') ? '\r\n' : '\n';
  const fixes = [...file.fixes].sort((a, b) => a.startLine - b.startLine);
  const groups: ProposedFix[][] = [];
  let lastEnd = 0;
  for (const f of fixes) {
    if (f.startLine <= lastEnd || f.endLine > lines.length) continue;
    const group = groups.at(-1);
    if (group && f.startLine - lastEnd - 1 <= 2 * CONTEXT) group.push(f);
    else groups.push([f]);
    lastEnd = f.endLine;
  }
  return groups.map((group) => {
    const first = group[0] as ProposedFix;
    const last = group.at(-1) as ProposedFix;
    const from = Math.max(1, first.startLine - CONTEXT);
    const to = Math.min(lines.length, last.endLine + CONTEXT);
    const body: string[] = [];
    let newCount = 0;
    let line = from;
    for (const f of group) {
      for (; line < f.startLine; line++, newCount++)
        body.push(diffLine(' ', lines[line - 1] ?? ''));
      for (; line <= f.endLine; line++) body.push(diffLine('-', lines[line - 1] ?? ''));
      // The replaced lines' ending is kept, including a missing final newline.
      const end = /\r?\n$/.exec(lines[f.endLine - 1] ?? '')?.[0] ?? '';
      const added = f.replacement.split('\n');
      added.forEach((l, i) => body.push(diffLine('+', l + (i === added.length - 1 ? end : eol))));
      newCount += added.length;
    }
    for (; line <= to; line++, newCount++) body.push(diffLine(' ', lines[line - 1] ?? ''));
    return { path: file.path, oldStart: from, oldCount: to - from + 1, newCount, body };
  });
}

/** A unified diff of `hunks` (in file order), with the new-side starts shifted by earlier hunks. */
export function renderPatch(hunks: readonly Hunk[]): string {
  let out = '';
  let path: string | null = null;
  let delta = 0;
  for (const h of hunks) {
    if (h.path !== path) {
      path = h.path;
      delta = 0;
      out += `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
    }
    out += `@@ -${h.oldStart},${h.oldCount} +${h.oldStart + delta},${h.newCount} @@\n`;
    out += h.body.join('');
    delta += h.newCount - h.oldCount;
  }
  return out;
}

/** `git apply --check` (read-only) of `patch` in `root`. */
async function applies(root: string, patch: string): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'ctxtruth-patch-'));
  try {
    const file = join(dir, 'fix.patch');
    await writeFile(file, patch);
    await git(root, ['apply', '--check', file]);
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Writes the proposed fixes of `findings` as a patch to `out`, the only file written: the docs
 * are never touched. Each hunk must pass `git apply --check`; one that does not is left out.
 */
export async function writePatch(
  root: string,
  out: string,
  findings: readonly Finding[],
  onWarning?: (message: string) => void,
): Promise<void> {
  let prefix = '';
  try {
    prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim();
  } catch {
    // not a git repository: paths stay relative to the root
  }
  const byFile = new Map<string, ProposedFix[]>();
  for (const f of findings) {
    if (f.proposedFix) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f.proposedFix]);
  }
  const kept: Hunk[] = [];
  for (const [file, fixes] of [...byFile].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const text = await readFile(join(root, file), 'utf8');
    for (const h of hunksOf({ path: `${prefix}${file}`, text, fixes })) {
      if (await applies(root, renderPatch([h]))) kept.push(h);
      else
        onWarning?.(`--patch: left out the fix at ${file}:${h.oldStart}: git apply --check failed`);
    }
  }
  if (kept.length === 0) {
    onWarning?.('--patch: no proposed fixes, nothing written');
    return;
  }
  const patch = renderPatch(kept);
  if (!(await applies(root, patch))) {
    onWarning?.('--patch: the combined patch does not apply, nothing written');
    return;
  }
  await writeFile(out, patch);
}
