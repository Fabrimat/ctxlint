import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checks as builtins } from './checks/index.js';
import { loadConfig, type Config } from './config/index.js';
import { buildRepoIndex, matchesAny } from './index/index.js';
import { parseMarkdown, type ParseOptions } from './parse/index.js';
import type { IgnoreRegion } from './parse/markers.js';
import { changedOnly, classify, ENVIRONMENT_CHECKS, renamed } from './compare.js';
import { changedFiles, resolveBase } from './git/diff.js';
import { withWorktree } from './git/worktree.js';
import { buildReport } from './report/index.js';
import type { Check, CheckResult, Claim, Comparison, RepoIndex, Report } from './types.js';

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
  /** The repository is untrusted: never import its config or plugin code. */
  untrusted?: boolean;
  /** Receives non-fatal configuration warnings (e.g. a rule for a plugin that is not loaded). */
  onWarning?: (message: string) => void;
}

/** The config with its plugins loaded: the checks to run and how to parse the docs. */
export interface Loaded {
  /** Plugin rules are filled with each check's default severity. */
  config: Config;
  /** Built-in checks, then plugin checks in config order. */
  checks: Check[];
  parse: ParseOptions;
}

const regions = (list: readonly { begin: string; end: string }[]): IgnoreRegion[] =>
  list.map((r) => ({ begin: new RegExp(r.begin), end: new RegExp(r.end) }));

/** Loads the config and its plugins (none when untrusted) once, for every commit a run visits. */
export async function load(
  root: string,
  opts: Pick<CheckOptions, 'configPath' | 'untrusted' | 'onWarning'>,
): Promise<Loaded> {
  const untrusted = opts.untrusted === true;
  const { config, path, warnings } = await loadConfig(root, opts.configPath, { untrusted });
  for (const w of warnings) opts.onWarning?.(w);
  const checks = [...builtins];
  const parse: ParseOptions = { prose: config.prose, ignoreRegions: regions(config.ignoreRegions) };
  const rules = { ...config.rules };
  if (config.plugins.length > 0 && !untrusted) {
    // Only taken when plugins are configured, so a plain run imports no plugin code.
    const { loadPlugins } = await import('./plugin/load.js');
    const { adapt } = await import('./plugin/adapter.js');
    const plugins = await loadPlugins(config, root, path);
    const pluginChecks = plugins.flatMap((p) => p.plugin.checks);
    parse.matchers = pluginChecks;
    parse.ignoreRegions = regions([
      ...config.ignoreRegions,
      ...plugins.flatMap((p) => p.plugin.ignoreRegions ?? []),
    ]);
    for (const { plugin, options } of plugins) {
      for (const c of plugin.checks) {
        rules[c.id] ??= c.defaultSeverity ?? 'warning';
        checks.push(adapt(plugin.name, c, options));
      }
    }
  }
  if (!untrusted) {
    const known = new Set(checks.map((c) => c.id));
    for (const id of Object.keys(rules)) {
      if (id.includes('/') && !known.has(id)) {
        opts.onWarning?.(`rule \`${id}\` names a check that no loaded plugin provides`);
      }
    }
  }
  return { config: { ...config, rules }, checks, parse };
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

/** Target docs in the index and the claims parsed from them. */
export async function collectClaims(
  index: RepoIndex,
  { config, parse }: Loaded,
  inScope: (doc: string) => boolean = () => true,
): Promise<{ claims: Claim[]; docFiles: string[] }> {
  const docFiles = index.files.files
    .filter((f) => matchesAny(f, config.targets) && !matchesAny(f, config.ignore) && inScope(f))
    .sort();
  const claims: Claim[] = [];
  for (const file of docFiles) {
    const text = await readFile(join(index.root, file), 'utf8');
    claims.push(...parseMarkdown(text, file, parse));
  }
  return { claims, docFiles };
}

/** Runs every enabled check on `claims`, which may come from another commit than `index`. */
export async function evaluate(
  claims: readonly Claim[],
  index: RepoIndex,
  { config, checks }: Loaded,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of checks) {
    const level = config.rules[c.id];
    if (level === undefined || level === 'off') continue;
    // A custom claim belongs to the plugin check that matched it.
    const mine = claims.filter(
      (claim) =>
        c.kinds.includes(claim.kind) && (claim.kind !== 'custom' || claim.meta?.['check'] === c.id),
    );
    if (mine.length > 0) results.push(...(await c.run(mine, { index, severity: level })));
  }
  return results;
}

/** One full check of the repository at `root` with an already-loaded config. */
async function runOnce(
  root: string,
  loaded: Loaded,
  inScope: (doc: string) => boolean,
  depsRoot?: string,
): Promise<RunOutput> {
  const index = await buildRepoIndex(root, depsRoot);
  if (depsRoot !== undefined && index.files.files.length === 0) {
    throw new Error(`the base checkout at ${root} lists no files`);
  }
  const { claims, docFiles } = await collectClaims(index, loaded, inScope);
  return { results: await evaluate(claims, index, loaded), docFiles };
}

export interface CheckOutput {
  report: Report;
  config: Config;
  /** Rule descriptions of the plugin checks, for SARIF. */
  descriptions: Record<string, string>;
}

export async function check(opts: CheckOptions): Promise<CheckOutput> {
  return checkLoaded(opts, await load(resolve(opts.root), opts));
}

/** `check` with an already-loaded config (blame reuses it for its probes). */
export async function checkLoaded(opts: CheckOptions, loaded: Loaded): Promise<CheckOutput> {
  const compare = opts.changedOnly === true || opts.newOnly === true;
  if (compare && opts.base === undefined) {
    throw new Error('--changed-only and --new-only need a base ref (--base <ref>)');
  }
  const started = performance.now();
  const root = resolve(opts.root);
  const { config } = loaded;
  const cwd = opts.cwd ?? process.cwd();
  const prefixes = (opts.paths ?? []).map((p) => toPrefix(root, cwd, p));
  const inScope = (f: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => p === '' || f === p || f.startsWith(`${p}/`));

  // --base alone is inert: git is only touched when a comparison is asked for.
  const ref = compare ? (opts.base as string) : undefined;
  const base = ref === undefined ? undefined : await resolveBase(root, ref);
  const diff = base === undefined ? undefined : await changedFiles(root, base.sha);

  let { results, docFiles } = await runOnce(root, loaded, inScope);
  let comparison: Comparison | undefined;

  if (base !== undefined && diff !== undefined) {
    const baseResults = opts.newOnly
      ? await withWorktree(root, base.sha, async (dir) => {
          // Scope base docs by their head path so a renamed doc is still compared.
          const baseScope = (f: string) => inScope(diff.renames.get(f) ?? f);
          const baseRoot = join(dir, base.prefix);
          // A root added by this change (e.g. a new package) had nothing at the base.
          if (!existsSync(baseRoot)) return [];
          const baseRun = await runOnce(baseRoot, loaded, baseScope, root);
          return baseRun.results.map((r) => renamed(r, diff.renames));
        })
      : undefined;
    if (opts.changedOnly) {
      results = changedOnly(results, baseResults ?? [], diff);
      const kept = new Set(results.map((r) => r.claim.file));
      docFiles = docFiles.filter((f) => kept.has(f) || diff.changed.has(f));
    }
    if (baseResults !== undefined) {
      const environment = new Set([
        ...ENVIRONMENT_CHECKS,
        ...loaded.checks.filter((c) => c.environment === true).map((c) => c.id),
      ]);
      comparison = {
        base: ref as string,
        baseSha: base.sha,
        ...classify(results, baseResults, diff, environment),
      };
    }
  }

  const report = buildReport(results, docFiles, {
    toolVersion: await toolVersion(),
    durationMs: Math.round(performance.now() - started),
  });
  if (comparison !== undefined) report.comparison = comparison;
  const descriptions = Object.fromEntries(
    loaded.checks.flatMap((c) => (c.description === undefined ? [] : [[c.id, c.description]])),
  );
  return { report, config, descriptions };
}
