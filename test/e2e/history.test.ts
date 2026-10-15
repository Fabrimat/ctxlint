import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import { makeTmpRepo } from '../helpers/tmp.js';

async function run(args: string[], cwd: string) {
  let out = '';
  let err = '';
  const io: CliIO = {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    cwd,
    isTTY: false,
    env: {},
  };
  return { code: await main(args, io), out, err };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const DOC = (path: string) => `# Docs\n\nSee \`${path}\` and run \`npm run build\`.\n`;
const lines = (out: string) => out.trim().split('\n');

function setup() {
  const repo = makeTmpRepo(
    {
      'README.md': DOC('src/a.ts'),
      'src/a.ts': 'export const a = 1;\n',
      'package.json': '{"scripts":{"build":"tsc"}}\n',
    },
    { git: true },
  );
  cleanups.push(repo.cleanup);
  let day = 1;
  const commit = (msg: string) => {
    const date = `2025-01-${String(day++).padStart(2, '0')}T12:00:00Z`;
    repo.git('add', '-A');
    execFileSync(
      'git',
      [
        '-C',
        repo.dir,
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        msg,
      ],
      { env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
    );
  };
  const write = (file: string, text: string) => writeFileSync(join(repo.dir, file), text);
  commit('init'); // day 1
  repo.git('mv', 'src/a.ts', 'src/b.ts');
  commit('rename'); // day 2: README is stale
  write('notes.txt', 'x');
  commit('notes'); // day 3
  write('README.md', DOC('src/b.ts'));
  commit('fix docs'); // day 4
  write('README.md', `${DOC('src/b.ts')}\nAlso \`src/ghost.ts\`.\n`);
  commit('bad docs'); // day 5
  return repo;
}

describe('ctxtruth history', { timeout: 30_000 }, () => {
  it('records opened and closed episodes as jsonl', async () => {
    const repo = setup();
    const before = repo.git('status', '--porcelain').toString();
    const { code, out } = await run(
      ['history', '--format', 'jsonl', '--repo-name', 'demo'],
      repo.dir,
    );
    expect(code).toBe(0);
    const eps = lines(out).map((l) => JSON.parse(l));
    expect(eps).toHaveLength(2);
    expect(eps[0]).toMatchObject({
      v: 1,
      repo: 'demo',
      check: 'paths',
      value: 'src/a.ts',
      cause: 'code',
      resolution: 'docs',
      commitsOpen: 2,
      daysOpen: 2,
      censored: false,
      openedAt: { subject: 'rename' },
      closedAt: { subject: 'fix docs' },
    });
    expect(eps[1]).toMatchObject({ value: 'src/ghost.ts', cause: 'docs', daysOpen: 0 });
    expect(eps[1].closedAt).toBeUndefined();
    expect(lines(repo.git('worktree', 'list').toString())).toHaveLength(1);
    expect(repo.git('status', '--porcelain').toString()).toBe(before);
    expect(existsSync(join(repo.dir, 'src/b.ts'))).toBe(true);
  });

  it('narrows with --max-commits', async () => {
    const repo = setup();
    const { out } = await run(['history', '--format', 'jsonl', '--max-commits', '2'], repo.dir);
    const eps = lines(out).map((l) => JSON.parse(l));
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ value: 'src/ghost.ts', cause: 'docs' });
  });

  it('--since walks the whole range, and --max-commits still caps it', async () => {
    const repo = setup();
    const root = repo.git('rev-list', '--max-parents=0', 'HEAD').toString().trim();
    const all = await run(['history', '--format', 'json', '--since', root], repo.dir);
    expect(JSON.parse(all.out).commits).toBe(4);
    const capped = await run(
      ['history', '--format', 'json', '--since', root, '--max-commits', '2'],
      repo.dir,
    );
    expect(JSON.parse(capped.out).commits).toBe(2);
  });

  it('prints a text summary and json', async () => {
    const repo = setup();
    const text = await run(['history'], repo.dir);
    expect(text.code).toBe(0);
    expect(text.out).toContain('5 commits walked, 2 stale episodes');
    expect(text.out).toContain('median days open (closed episodes): 2');
    expect(text.out).toContain('README.md  2');
    const json = JSON.parse((await run(['history', '--format', 'json'], repo.dir)).out);
    expect(json).toMatchObject({ version: 1, commits: 5, summary: { episodes: 2, open: 1 } });
    expect(json.episodes).toHaveLength(2);
  });

  it('writes to --output', async () => {
    const repo = setup();
    const args = ['history', '--format', 'jsonl', '--output', 'h.jsonl', '--checks', 'paths'];
    await run(args, repo.dir);
    expect(lines(readFileSync(join(repo.dir, 'h.jsonl'), 'utf8'))).toHaveLength(2);
  });

  it('exits 2 outside a git repository', async () => {
    const dir = makeTmpRepo({ 'README.md': '# x\n' });
    cleanups.push(dir.cleanup);
    const { code, err } = await run(['history'], dir.dir);
    expect(code).toBe(2);
    expect(err).toContain('needs a git repository');
  });
});
