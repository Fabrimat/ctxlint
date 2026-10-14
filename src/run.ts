import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checks } from './checks/index.js';
import { loadConfig, type Config } from './config/index.js';
import { buildRepoIndex, matchesAny } from './index/index.js';
import { parseMarkdown } from './parse/index.js';
import { buildReport } from './report/index.js';
import type { CheckResult, Claim, Report } from './types.js';

export interface CheckOptions {
  /** Repository root. */
  root: string;
  /** Narrow the scan to these files or directories (relative to `cwd`). */
  paths?: string[];
  /** Explicit config file, resolved against `root`. */
  configPath?: string;
  /** Base for relative `paths`. Defaults to the process working directory. */
  cwd?: string;
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

export async function check(opts: CheckOptions): Promise<{ report: Report; config: Config }> {
  const started = performance.now();
  const root = resolve(opts.root);
  const { config } = await loadConfig(root, opts.configPath);
  const index = await buildRepoIndex(root);

  let docFiles = index.files.files
    .filter((f) => matchesAny(f, config.targets) && !matchesAny(f, config.ignore))
    .sort();

  if (opts.paths !== undefined && opts.paths.length > 0) {
    const cwd = opts.cwd ?? process.cwd();
    const prefixes = opts.paths.map((p) => toPrefix(root, cwd, p));
    docFiles = docFiles.filter((f) =>
      prefixes.some((p) => p === '' || f === p || f.startsWith(`${p}/`)),
    );
  }

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

  const report = buildReport(results, docFiles, {
    toolVersion: await toolVersion(),
    durationMs: Math.round(performance.now() - started),
  });
  return { report, config };
}
