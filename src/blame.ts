import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkLoaded, evaluate, load, type CheckOptions } from './run.js';
import { git } from './git/diff.js';
import { assertFullHistory, commitInfo, firstParentChain, type CommitInfo } from './git/history.js';
import { withWorktree } from './git/worktree.js';
import { buildRepoIndex } from './index/index.js';
import { reportedResults } from './report/build.js';
import { fingerprint, type Finding } from './types.js';

export type BlameCause = 'broken-by' | 'stale-when-written' | 'uncommitted' | 'undetermined';

export interface BlameChange {
  status: 'renamed' | 'deleted';
  from: string;
  /** New path of a rename. */
  to?: string;
}

export interface BlameFinding {
  finding: Finding;
  /** The claim text, e.g. the path or script name. */
  value: string;
  /** The commit that wrote the doc line; null when the line is not committed. */
  written: CommitInfo | null;
  cause: BlameCause;
  /** `broken-by`: the commit that made the claim false. `stale-when-written`: the writing commit. */
  commit?: CommitInfo;
  commitsAgo?: number;
  /**
   * `broken-by`: whether the claim was confirmed true at the commit before `commit`. False when it
   * was only unknown there, so the real break may be earlier.
   */
  confirmedBefore?: boolean;
  /** Files the claim relied on that `commit` renamed or deleted. */
  changes?: BlameChange[];
}

export interface BlameReport {
  version: 1;
  findings: BlameFinding[];
  /** Commits evaluated (one checkout each). */
  probes: number;
  durationMs: number;
}

/** `unknown`: the check cannot verify the claim at that commit. The search treats it as ok. */
export type Verdict = 'fail' | 'ok' | 'unknown';
/** Verdicts for `ids` against the code at chain commit `index`. */
export type Evaluator = (index: number, ids: number[]) => Promise<Map<number, Verdict>>;

/**
 * Finds, per item, the first chain index in `[lo, last]` where it fails, or null when it does not
 * fail at `last`. Probes are shared: each round evaluates one midpoint for every item whose
 * interval contains it.
 *
 * Assumes monotonicity (ok, then fail from some index on). A claim that was broken, fixed and
 * broken again yields *a* transition, not necessarily the latest.
 */
export async function multiBisect(
  items: readonly { id: number; lo: number }[],
  last: number,
  evaluator: Evaluator,
): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  if (items.length === 0) return out;
  // lastPass is exclusive knowledge: lo - 1 stands for "before the search range".
  const open = new Map<number, { pass: number; fail: number }>();
  const head = await evaluator(
    last,
    items.map((i) => i.id),
  );
  for (const { id, lo } of items) {
    if (head.get(id) === 'fail') open.set(id, { pass: lo - 1, fail: last });
    else out.set(id, null);
  }
  for (;;) {
    let widest: { pass: number; fail: number } | undefined;
    for (const iv of open.values()) {
      if (iv.fail - iv.pass > 1 && (!widest || iv.fail - iv.pass > widest.fail - widest.pass)) {
        widest = iv;
      }
    }
    if (!widest) break;
    const mid = Math.floor((widest.pass + widest.fail) / 2);
    const ids = [...open].filter(([, iv]) => iv.pass < mid && mid < iv.fail).map(([id]) => id);
    const verdicts = await evaluator(mid, ids);
    for (const id of ids) {
      const iv = open.get(id) as { pass: number; fail: number };
      if (verdicts.get(id) === 'fail') iv.fail = mid;
      else iv.pass = mid;
    }
  }
  for (const [id, iv] of open) out.set(id, iv.fail);
  return out;
}

const ZERO = /^0+$/;

/** Line number -> commit that last wrote it in the working tree; uncommitted lines are absent. */
async function blameFile(root: string, file: string): Promise<Map<number, string>> {
  const lines = new Map<number, string>();
  let out: string;
  try {
    out = await git(root, ['blame', '--porcelain', '--', file]);
  } catch {
    return lines; // untracked file
  }
  for (const row of out.split('\n')) {
    const m = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(row);
    if (m && !ZERO.test(m[1] as string)) lines.set(Number(m[2]), m[1] as string);
  }
  return lines;
}

async function isAncestor(root: string, a: string, b: string): Promise<boolean> {
  try {
    await git(root, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}

/** First chain index whose commit contains `sha`; ancestry is monotone along the chain. */
async function firstContaining(root: string, chain: string[], sha: string): Promise<number> {
  let lo = 0;
  let hi = chain.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (await isAncestor(root, sha, chain[mid] as string)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Files of `from` that `to` renamed or deleted, restricted to `relied`. */
async function changesBetween(
  root: string,
  from: string,
  to: string,
  relied: ReadonlySet<string>,
): Promise<BlameChange[]> {
  const fields = (
    await git(root, ['diff', '--name-status', '-M', '-z', '--relative', '--no-ext-diff', from, to])
  ).split('\0');
  const changes: BlameChange[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? '';
    if (status === '') continue;
    const path = fields[i++] ?? '';
    if (status.startsWith('R')) {
      const dest = fields[i++] ?? '';
      if (relied.has(path)) changes.push({ status: 'renamed', from: path, to: dest });
    } else if (status === 'D' && relied.has(path)) {
      changes.push({ status: 'deleted', from: path });
    }
  }
  return changes;
}

export type BlameOptions = Pick<
  CheckOptions,
  'root' | 'paths' | 'configPath' | 'cwd' | 'untrusted' | 'onWarning'
>;

/**
 * For every failing claim of the working tree, finds the commit that made it false. The head
 * claims are evaluated against the code of historical commits. `unknown` counts as not failing:
 * blame finds the first commit where the claim is *detectably* false.
 */
export async function blame(opts: BlameOptions): Promise<BlameReport> {
  const started = performance.now();
  const root = resolve(opts.root);
  await assertFullHistory(root);
  const loaded = await load(root, opts);
  // Never model-judged: blame follows the verified findings only.
  const plain: CheckOptions = { ...opts };
  delete plain.llm;
  const { report } = await checkLoaded(plain, loaded);
  const results = reportedResults(report);
  const chain = await firstParentChain(root);
  if (chain.length === 0) throw new Error('blame needs at least one commit');
  const last = chain.length - 1;
  const prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim().replace(/\/$/, '');

  const infos = new Map<string, CommitInfo>();
  const info = async (sha: string): Promise<CommitInfo> => {
    const hit = infos.get(sha);
    if (hit) return hit;
    const fresh = await commitInfo(root, sha);
    infos.set(sha, fresh);
    return fresh;
  };
  const ago = async (sha: string): Promise<number> =>
    Number((await git(root, ['rev-list', '--count', '--first-parent', `${sha}..HEAD`])).trim());

  const blamed = new Map<string, Map<number, string>>();
  for (const f of new Set(results.map((r) => (r.finding as Finding).file))) {
    blamed.set(f, await blameFile(root, f));
  }
  const written = results.map(
    (r) => blamed.get((r.finding as Finding).file)?.get((r.finding as Finding).line) ?? null,
  );
  const fps = results.map(fingerprint);
  const relied = new Map<string, ReadonlySet<string>>();
  let probes = 0;

  const { first, stale, atHead } = await withWorktree(
    root,
    chain[last] as string,
    async (dir, checkout) => {
      let current = chain[last] as string;
      const atHead = new Map<number, Verdict>();
      const probe = async (sha: string, ids: number[]): Promise<Map<number, Verdict>> => {
        probes++;
        if (sha !== current) {
          await checkout(sha);
          current = sha;
        }
        const verdicts = new Map<number, Verdict>(ids.map((id) => [id, 'unknown']));
        const at = join(dir, prefix);
        if (!existsSync(at)) return verdicts;
        const rs = await evaluate(
          ids.map((id) => (results[id] as (typeof results)[number]).claim),
          await buildRepoIndex(at, root),
          loaded,
        );
        const byFp = new Map(rs.map((r) => [fingerprint(r), r]));
        for (const id of ids) {
          const r = byFp.get(fps[id] as string);
          if (r?.status === 'fail') verdicts.set(id, 'fail');
          else if (r?.status === 'pass') {
            verdicts.set(id, 'ok');
            relied.set(`${sha}\0${id}`, new Set(r.resolvedFiles));
          }
        }
        if (sha === chain[last]) for (const [id, v] of verdicts) atHead.set(id, v);
        return verdicts;
      };

      // Stale when written: the claim already failed at the commit that wrote its line.
      const early = new Set<number>();
      const bySha = new Map<string, number[]>();
      written.forEach((sha, id) => {
        if (sha !== null) bySha.set(sha, [...(bySha.get(sha) ?? []), id]);
      });
      for (const [sha, ids] of bySha) {
        for (const [id, v] of await probe(sha, ids)) if (v === 'fail') early.add(id);
      }

      const items = [];
      for (const [id, sha] of written.entries()) {
        if (early.has(id)) continue;
        items.push({ id, lo: sha === null ? last : await firstContaining(root, chain, sha) });
      }
      const found = await multiBisect(items, last, (index, ids) =>
        probe(chain[index] as string, ids),
      );

      // The commit before each culprit is needed for its rename hints.
      const parents = new Map<string, number[]>();
      for (const [id, idx] of found) {
        if (idx === null || idx === 0 || written[id] === null) continue;
        const p = chain[idx - 1] as string;
        if (!relied.has(`${p}\0${id}`)) parents.set(p, [...(parents.get(p) ?? []), id]);
      }
      for (const [p, ids] of parents) await probe(p, ids);

      return { first: found, stale: early, atHead };
    },
  );

  const findings: BlameFinding[] = [];
  for (const [id, r] of results.entries()) {
    const finding = r.finding as Finding;
    const w = written[id] ?? null;
    const base = { finding, value: r.claim.value, written: w === null ? null : await info(w) };
    if (stale.has(id) || (w === null && first.get(id) === last)) {
      const commit = w === null ? undefined : base.written;
      findings.push({
        ...base,
        cause: 'stale-when-written',
        ...(commit && { commit, commitsAgo: await ago(commit.sha) }),
      });
      continue;
    }
    const idx = first.get(id) ?? null;
    if (idx === null || w === null) {
      // Only a confirmed pass at HEAD proves the working tree alone broke the claim.
      const cause = atHead.get(id) === 'ok' ? 'uncommitted' : 'undetermined';
      findings.push({ ...base, cause });
      continue;
    }
    const sha = chain[idx] as string;
    const commit = await info(sha);
    const files = idx > 0 ? relied.get(`${chain[idx - 1]}\0${id}`) : undefined;
    const entry: BlameFinding = {
      ...base,
      cause: 'broken-by',
      commit,
      commitsAgo: last - idx,
      confirmedBefore: idx === 0 || files !== undefined,
    };
    if (files) {
      const changes = await changesBetween(root, chain[idx - 1] as string, sha, files);
      if (changes.length > 0) entry.changes = changes;
    }
    findings.push(entry);
  }
  return {
    version: 1,
    findings,
    probes,
    durationMs: Math.round(performance.now() - started),
  };
}
