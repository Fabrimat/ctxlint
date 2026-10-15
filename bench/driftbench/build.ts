// Rebuilds the DriftBench dataset: node bench/driftbench/build.ts (after `pnpm build`).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Entry {
  name: string;
  url: string;
  sha: string;
  root?: string;
  checks?: string;
  maxCommits?: number;
}

const here = import.meta.dirname;
const cli = join(here, '../../dist/cli.js');
const cache = process.env['DRIFTBENCH_CACHE'] ?? join(tmpdir(), 'driftbench');
// A hooks dir that does not exist: cloned repos never run their own hooks. No install, no scripts.
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, '-c', `core.hooksPath=${join(cache, 'no-hooks')}`, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' },
  });

const entries = JSON.parse(readFileSync(join(here, 'repos.json'), 'utf8')) as Entry[];
mkdirSync(join(here, 'data'), { recursive: true });
mkdirSync(cache, { recursive: true });

for (const e of entries) {
  const dir = join(cache, e.name);
  if (!existsSync(dir)) git(cache, 'clone', '--quiet', '--filter=blob:none', e.url, dir);
  else git(dir, 'fetch', '--quiet', 'origin');
  git(dir, 'checkout', '--quiet', '--detach', e.sha);
  const args = [cli, 'history', '--root', e.root ? join(dir, e.root) : dir, '--repo-name', e.name];
  args.push('--format', 'jsonl', '--max-commits', String(e.maxCommits ?? 100));
  if (e.checks) args.push('--checks', e.checks);
  const out = execFileSync('node', args, { encoding: 'utf8', maxBuffer: 1 << 30 });
  writeFileSync(join(here, 'data', `${e.name}.jsonl`), out);
  const n = out.split('\n').filter(Boolean).length;
  console.log(`${e.name}@${e.sha.slice(0, 7)}: ${n} episodes`);
}
