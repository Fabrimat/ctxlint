import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Config } from './config/index.js';
import { git } from './git/diff.js';
import { assertFullHistory, commitInfo, firstParentChain } from './git/history.js';
import { withWorktree } from './git/worktree.js';
import { buildRepoIndex } from './index/index.js';
import { collectClaims, evaluate, load, type Loaded } from './run.js';
import { fingerprint, type CheckId, type CheckResult, type ClaimKind } from './types.js';

export interface CommitRef {
  sha: string;
  /** Author date, ISO 8601. */
  date: string;
  subject: string;
}

/** The few fields of a check result a history run keeps per commit. */
export interface SlimResult {
  fingerprint: string;
  status: CheckResult['status'];
  checkId: CheckId;
  kind: ClaimKind;
  file: string;
  line: number;
  value: string;
  section: string[];
  message?: string;
  suggestion?: string;
}

/** One JSONL line of `ctxtruth history`: a doc claim that was false from `openedAt` until `closedAt`. */
export interface Episode {
  v: 1;
  repo: string;
  check: CheckId;
  kind: ClaimKind;
  file: string;
  value: string;
  section: string[];
  message: string;
  suggestion?: string;
  openedAt: CommitRef;
  /** `unknown` for claims already failing at the first walked commit. */
  cause: 'code' | 'docs' | 'unknown';
  closedAt?: CommitRef;
  resolution?: 'code' | 'docs';
  commitsOpen: number;
  /** Until `closedAt`, else until the last walked commit. */
  daysOpen: number;
  /** Left-censored: the claim was already failing when the walk started. */
  censored: boolean;
}

export const slim = (r: CheckResult): SlimResult => ({
  fingerprint: fingerprint(r),
  status: r.status,
  checkId: r.checkId,
  kind: r.claim.kind,
  file: r.claim.file,
  line: r.claim.line,
  value: r.claim.value,
  section: r.claim.section,
  ...(r.finding && { message: r.finding.message }),
  ...(r.finding?.suggestion !== undefined && { suggestion: r.finding.suggestion }),
});

const DAY_MS = 86_400_000;
const days = (from: string, to: string): number =>
  Math.round(((Date.parse(to) - Date.parse(from)) / DAY_MS) * 100) / 100;

interface Open {
  episode: Episode;
  index: number;
}

/**
 * Pure episode tracking over consecutive commits. Matching per fingerprint is counted (like
 * compare.ts): with N episodes open for a claim, a commit with M > N failures opens M - N more,
 * and one with fewer failures (and unknowns) than open episodes closes the surplus.
 */
export class EpisodeTracker {
  private readonly open = new Map<string, Open[]>();
  private readonly done: Episode[] = [];
  private n = -1;
  private last: CommitRef | undefined;

  constructor(private readonly repo: string) {}

  /** `changed`: files changed since the previous commit (empty for the first). */
  push(commit: CommitRef, changed: ReadonlySet<string>, results: readonly SlimResult[]): void {
    this.n++;
    this.last = commit;
    const first = this.n === 0;
    const groups = new Map<string, SlimResult[]>();
    for (const r of results) groups.set(r.fingerprint, [...(groups.get(r.fingerprint) ?? []), r]);
    for (const key of this.open.keys()) if (!groups.has(key)) groups.set(key, []);

    for (const [key, rs] of groups) {
      const fails = rs.filter((r) => r.status === 'fail').sort((a, b) => a.line - b.line);
      const unknown = rs.filter((r) => r.status === 'unknown').length;
      const open = this.open.get(key) ?? [];
      for (const r of fails.slice(open.length)) {
        open.push({
          index: this.n,
          episode: {
            v: 1,
            repo: this.repo,
            check: r.checkId,
            kind: r.kind,
            file: r.file,
            value: r.value,
            section: r.section,
            message: r.message ?? '',
            ...(r.suggestion !== undefined && { suggestion: r.suggestion }),
            openedAt: commit,
            cause: first ? 'unknown' : changed.has(r.file) ? 'docs' : 'code',
            commitsOpen: 0,
            daysOpen: 0,
            censored: first,
          },
        });
      }
      // Unknown neither opens nor closes: an episode only ends on a pass or a vanished claim.
      for (let i = open.length - fails.length - unknown; i > 0; i--) {
        const { episode, index } = open.pop() as Open;
        episode.closedAt = commit;
        episode.resolution = changed.has(episode.file) ? 'docs' : 'code';
        episode.commitsOpen = this.n - index;
        episode.daysOpen = days(episode.openedAt.date, commit.date);
        this.done.push(episode);
      }
      if (open.length > 0) this.open.set(key, open);
      else this.open.delete(key);
    }
  }

  /** Closed episodes plus the still-open ones, measured up to the last pushed commit. */
  finish(): Episode[] {
    const head = this.last;
    const stillOpen = [...this.open.values()].flat().map(({ episode, index }) => ({
      ...episode,
      commitsOpen: this.n - index,
      daysOpen: head === undefined ? 0 : days(episode.openedAt.date, head.date),
    }));
    return [...this.done, ...stillOpen].sort(
      (a, b) =>
        Date.parse(a.openedAt.date) - Date.parse(b.openedAt.date) ||
        a.file.localeCompare(b.file) ||
        a.value.localeCompare(b.value),
    );
  }
}

export interface HistorySummary {
  episodes: number;
  open: number;
  /** Share of episodes still open, 0-100. */
  openPct: number;
  causes: { code: number; docs: number; unknown: number };
  /** Median `daysOpen` of closed episodes; null when none closed. */
  medianDaysClosed: number | null;
  topFiles: { file: string; episodes: number }[];
}

export function summarize(episodes: readonly Episode[]): HistorySummary {
  const closed = episodes
    .filter((e) => e.closedAt !== undefined)
    .map((e) => e.daysOpen)
    .sort((a, b) => a - b);
  const mid = closed.length >> 1;
  const median =
    closed.length === 0
      ? null
      : closed.length % 2
        ? (closed[mid] as number)
        : ((closed[mid - 1] as number) + (closed[mid] as number)) / 2;
  const perFile = new Map<string, number>();
  const causes = { code: 0, docs: 0, unknown: 0 };
  for (const e of episodes) {
    perFile.set(e.file, (perFile.get(e.file) ?? 0) + 1);
    causes[e.cause]++;
  }
  const open = episodes.length - closed.length;
  return {
    episodes: episodes.length,
    open,
    openPct: episodes.length === 0 ? 0 : Math.round((open / episodes.length) * 1000) / 10,
    causes,
    medianDaysClosed: median === null ? null : Math.round(median * 100) / 100,
    topFiles: [...perFile]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([file, n]) => ({ file, episodes: n })),
  };
}

export interface HistoryOptions {
  root: string;
  configPath?: string;
  /** Only the most recent N commits of the first-parent chain. */
  maxCommits?: number;
  /** Start after this ref (exclusive); must be on the first-parent chain of HEAD. */
  since?: string;
  /** Run only these checks. */
  checks?: string[];
  repoName?: string;
  /** The repository is untrusted: never import its config or plugin code. */
  untrusted?: boolean;
  /** Receives non-fatal configuration warnings. */
  onWarning?: (message: string) => void;
  onProgress?: (done: number, total: number) => void;
}

export interface HistoryResult {
  repo: string;
  commits: number;
  episodes: Episode[];
  summary: HistorySummary;
}

export async function history(opts: HistoryOptions): Promise<HistoryResult> {
  const root = resolve(opts.root);
  await assertFullHistory(root);
  const base = await load(root, opts);
  const known = base.checks.map((c) => c.id);
  for (const id of opts.checks ?? []) {
    if (!known.includes(id as CheckId)) {
      throw new Error(`unknown check \`${id}\` (known: ${known.join(', ')})`);
    }
  }
  const rules = { ...base.config.rules };
  for (const id of known) {
    // `commands` needs installed binaries, which a historical checkout lacks: always off here.
    if (id === 'commands' || (opts.checks && !opts.checks.includes(id))) rules[id] = 'off';
  }
  const config: Config = { ...base.config, rules };
  const loaded: Loaded = { ...base, config };

  const prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim().replace(/\/$/, '');
  let chain = await firstParentChain(root);
  if (opts.since !== undefined) {
    let sha: string;
    try {
      const ref = `${opts.since}^{commit}`;
      sha = (await git(root, ['rev-parse', '--verify', '--quiet', ref])).trim();
    } catch {
      throw new Error(`cannot resolve --since ref \`${opts.since}\``);
    }
    const at = chain.indexOf(sha);
    if (at < 0)
      throw new Error(`--since \`${opts.since}\` is not on the first-parent chain of HEAD`);
    chain = chain.slice(at + 1);
  }
  // 100 commits unless the range is bounded by --since; an explicit cap always applies.
  const cap = opts.maxCommits ?? (opts.since === undefined ? 100 : undefined);
  if (cap !== undefined) chain = chain.slice(-cap);
  const first = chain[0];
  if (first === undefined) throw new Error('no commits to walk');

  const repo = opts.repoName ?? basename(root);
  const tracker = new EpisodeTracker(repo);
  await withWorktree(root, first, async (dir, checkout) => {
    let prev: string | undefined;
    for (const [i, sha] of chain.entries()) {
      opts.onProgress?.(i + 1, chain.length);
      let changed = new Set<string>();
      if (prev !== undefined) {
        await checkout(sha);
        // --relative keeps paths relative to `root`; --no-renames lists both sides of a move.
        const args = ['diff', '--name-only', '-z', '--no-renames', '--relative', prev, sha];
        changed = new Set((await git(root, args)).split('\0').filter(Boolean));
      }
      prev = sha;
      const at = join(dir, prefix);
      let results: SlimResult[] = [];
      if (existsSync(at)) {
        const index = await buildRepoIndex(at, root);
        const { claims } = await collectClaims(index, loaded);
        results = (await evaluate(claims, index, loaded)).map(slim);
      }
      const info = await commitInfo(root, sha);
      tracker.push({ sha: info.sha, date: info.date, subject: info.subject }, changed, results);
    }
  });
  const episodes = tracker.finish();
  return { repo, commits: chain.length, episodes, summary: summarize(episodes) };
}
