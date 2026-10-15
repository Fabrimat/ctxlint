import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { blame } from '../../src/blame.js';
import { main, type CliIO } from '../../src/cli.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const repos: ReturnType<typeof makeTmpRepo>[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts });
const DOC = [
  '# Guide',
  '',
  'Format helpers live in `src/old.ts`.',
  'Run `npm run build` to build.',
  'Config is in `src/conf.ts`.',
  '',
].join('\n');

/** Six commits, see the assertions below. */
function history() {
  const r = makeTmpRepo(
    {
      'package.json': pkg({ build: 'tsc', test: 'vitest' }),
      'src/old.ts': 'export const a = 1;\n',
      'src/conf.ts': 'export const c = 1;\n',
      'AGENTS.md': DOC,
    },
    { git: true },
  );
  repos.push(r);
  let n = 0;
  const commit = (msg: string) => {
    n++;
    r.git('add', '-A');
    const date = `2026-01-0${n}T10:00:00Z`;
    const cfg = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
    execFileSync('git', ['-C', r.dir, ...cfg, 'commit', '-q', '-m', msg], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  };
  const write = (f: string, t: string) => writeFileSync(join(r.dir, f), t);
  commit('one');
  write('README.md', '# R\n');
  commit('two');
  r.git('mv', 'src/old.ts', 'src/new.ts');
  commit('three');
  write('README.md', '# R2\n');
  commit('four');
  write('package.json', pkg({ test: 'vitest' }));
  commit('five');
  write('AGENTS.md', `${DOC}Also see \`src/never.ts\`.\n`);
  commit('six');
  return r;
}

const status = (dir: string) =>
  execFileSync('git', ['-C', dir, 'status', '--porcelain']).toString();
const worktrees = (dir: string) =>
  execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'])
    .toString()
    .match(/^worktree /gm)?.length;

async function run(cwd: string, args: string[]) {
  let out = '';
  let err = '';
  const io: CliIO = {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    cwd,
    isTTY: false,
    env: {},
  };
  return { code: await main(['blame', ...args], io), out, err };
}

// Each run walks real git history on Windows-speed disks.
const SLOW = 60_000;

describe('blame', () => {
  it(
    'finds the commit that broke each claim',
    async () => {
      const r = history();
      rmSync(join(r.dir, 'src/conf.ts'));
      const before = status(r.dir);

      const report = await blame({ root: r.dir });
      const by = Object.fromEntries(report.findings.map((b) => [b.value, b]));

      expect(by['src/old.ts']).toMatchObject({
        cause: 'broken-by',
        commit: { subject: 'three' },
        commitsAgo: 3,
        confirmedBefore: true,
        changes: [{ status: 'renamed', from: 'src/old.ts', to: 'src/new.ts' }],
      });
      expect(by['src/old.ts']?.commit?.date.startsWith('2026-01-03')).toBe(true);
      expect(by['src/old.ts']?.written?.subject).toBe('one');
      expect(by['build']).toMatchObject({ cause: 'broken-by', commit: { subject: 'five' } });
      expect(by['src/never.ts']).toMatchObject({
        cause: 'stale-when-written',
        commit: { subject: 'six' },
      });
      expect(by['src/conf.ts']).toMatchObject({ cause: 'uncommitted' });
      expect(by['src/conf.ts']?.commit).toBeUndefined();

      expect(status(r.dir)).toBe(before);
      expect(worktrees(r.dir)).toBe(1);
    },
    SLOW,
  );

  it(
    'prints agent and json output through the CLI and exits 0',
    async () => {
      const r = history();
      const agent = await run(r.dir, ['--format', 'agent']);
      expect(agent.code).toBe(0);
      expect(agent.out).toMatch(/^ctxtruth blame: 3 stale claims\./);
      expect(agent.out).toContain('AGENTS.md:3:');
      expect(agent.out).toContain('renamed to `src/new.ts` there');
      const json = JSON.parse((await run(r.dir, ['--format', 'json'])).out);
      expect(json.version).toBe(1);
      expect(json.findings.map((f: { cause: string }) => f.cause).sort()).toEqual([
        'broken-by',
        'broken-by',
        'stale-when-written',
      ]);
      expect(typeof json.probes).toBe('number');
      expect((await run(r.dir, ['--format', 'text'])).out).toContain('broken by');
    },
    SLOW,
  );

  it(
    'exits 2 outside git and on a shallow clone, naming the fix',
    async () => {
      const plain = makeTmpRepo({ 'AGENTS.md': '# x\n' });
      repos.push(plain);
      const none = await run(plain.dir, []);
      expect(none.code).toBe(2);
      expect(none.err).toContain('not one');

      const src = history();
      const clone = makeTmpRepo({});
      repos.push(clone);
      rmSync(clone.dir, { recursive: true, force: true });
      const url = `file://${src.dir.replaceAll('\\', '/')}`;
      execFileSync('git', ['clone', '-q', '--depth', '1', url, clone.dir]);
      const shallow = await run(clone.dir, []);
      expect(shallow.code).toBe(2);
      expect(shallow.err).toContain('git fetch --unshallow');
    },
    SLOW,
  );
});

describe('blame on claims the check cannot verify in the past', () => {
  it(
    'reports undetermined rather than uncommitted',
    async () => {
      const r = makeTmpRepo(
        {
          'package.json': JSON.stringify({ name: 'x', dependencies: { zod: '^4.1.0' } }),
          'AGENTS.md': 'Uses `zod@3` for validation.\n',
        },
        { git: true },
      );
      repos.push(r);
      r.git('add', '-A');
      r.git('commit', '-q', '-m', 'one');
      const report = await blame({ root: r.dir });
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({ cause: 'undetermined' });
      const agent = await run(r.dir, ['--format', 'agent']);
      expect(agent.out).toContain('could not be traced through history');
    },
    SLOW,
  );
});
