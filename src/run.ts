import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checks } from './checks/index.js';
import { loadConfig, type Config } from './config/index.js';
import { buildRepoIndex, matchesAny } from './index/index.js';
import { parseMarkdown } from './parse/index.js';
import { changedOnly, classify, renamed } from './compare.js';
import { changedFiles, resolveBase } from './git/diff.js';
import { withWorktree } from './git/worktree.js';
import { buildReport } from './report/index.js';
import type { CheckResult, Claim, Comparison, Report } from './types.js';

export interface CheckOptions {
  /** Repository root. */
  root: string;
  /** Narrow the scan to these files or directories (relative to `cwd`). */
  paths?: string[];
  /** Explicit config file, resolved against `root`. */
  configPath?: string;
  /** Base for relative `paths`. Defaults to the process working directory. */
  cwd?: string;
  /** Git ref to compare with (required by `changedOnly` and `newOnly`). */
  base?: string;
  /**
   * Only keep claims in docs changed since `base`, or whose resolved files changed. A speed filter
   * that trades recall; `newOnly` is the precision mode.
   */
  changedOnly?: boolean;
  /** Only report failures that are new since `base` (runs a second check on the base commit). */
  newOnly?: boolean;
}

async function toolVersion(): Promise<string> {
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(await readFile(url, 'utf8')) as { version: string };
  return pkg.version;
}

/** Root-relative POSIX prefix for a CLI path argument; '' means the whole repo. */
function toPrefix(root: string, cwd: string, arg: string): string {
  const rel = relative(root, isAbsolute(arg) ? arg : resolve(cwd, arg));
  return rel.split(sep).join('/').replace(/\/+$/, '');
}

interface RunOutput {
  results: CheckResult[];
  docFiles: string[];
}

/** One full check of the repository at `root` with an already-loaded config. */
async function runOnce(
  root: string,
  config: Config,
  inScope: (doc: string) => boolean,
  depsRoot?: string,
): Promise<RunOutput> {
  const index = await buildRepoIndex(root, depsRoot);
  if (depsRoot !== undefined && index.files.files.length === 0) {
    throw new Error(`the base checkout at ${root} lists no files`);
  }

  const docFiles = index.files.files
    .filter((f) => matchesAny(f, config.targets) && !matchesAny(f, config.ignore) && inScope(f))
    .sort();

  const claims: Claim[] = [];
  for (const file of docFiles) {
    const text = await readFile(join(root, file), 'utf8');
    claims.push(...parseMarkdown(text, file, { prose: config.prose }));
  }

  const results: CheckResult[] = [];
  for (const c of checks) {
    const level = config.rules[c.id];
    if (level === 'off') continue;
    const mine = claims.filter((claim) => c.kinds.includes(claim.kind));
    results.push(...(await c.run(mine, { index, severity: level })));
  }
  return { results, docFiles };
}

export async function check(opts: CheckOptions): Promise<{ report: Report; config: Config }> {
  const compare = opts.changedOnly === true || opts.newOnly === true;
  if (compare && opts.base === undefined) {
    throw new Error('--changed-only and --new-only need a base ref (--base <ref>)');
  }
  const started = performance.now();
  const root = resolve(opts.root);
  const { config } = await loadConfig(root, opts.configPath);
  const cwd = opts.cwd ?? process.cwd();
  const prefixes = (opts.paths ?? []).map((p) => toPrefix(root, cwd, p));
  const inScope = (f: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => p === '' || f === p || f.startsWith(`${p}/`));

  // --base alone is inert: git is only touched when a comparison is asked for.
  const ref = compare ? (opts.base as string) : undefined;
  const base = ref === undefined ? undefined : await resolveBase(root, ref);
  const diff = base === undefined ? undefined : await changedFiles(root, base.sha);

  let { results, docFiles } = await runOnce(root, config, inScope);
  let comparison: Comparison | undefined;

  if (base !== undefined && diff !== undefined) {
    const baseResults = opts.newOnly
      ? await withWorktree(root, base.sha, async (dir) => {
          // Scope base docs by their head path so a renamed doc is still compared.
          const baseScope = (f: string) => inScope(diff.renames.get(f) ?? f);
          const baseRoot = join(dir, base.prefix);
          // A root added by this change (e.g. a new package) had nothing at the base.
          if (!existsSync(baseRoot)) return [];
          const baseRun = await runOnce(baseRoot, config, baseScope, root);
          return baseRun.results.map((r) => renamed(r, diff.renames));
        })
      : undefined;
    if (opts.changedOnly) {
      results = changedOnly(results, baseResults ?? [], diff);
      const kept = new Set(results.map((r) => r.claim.file));
      docFiles = docFiles.filter((f) => kept.has(f) || diff.changed.has(f));
    }
    if (baseResults !== undefined) {
      comparison = {
        base: ref as string,
        baseSha: base.sha,
        ...classify(results, baseResults, diff),
      };
    }
  }

  const report = buildReport(results, docFiles, {
    toolVersion: await toolVersion(),
    durationMs: Math.round(performance.now() - started),
  });
  if (comparison !== undefined) report.comparison = comparison;
  return { report, config };
}
