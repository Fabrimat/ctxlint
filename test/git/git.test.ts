import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changedFiles, resolveBase } from '../../src/git/diff.js';
import { withWorktree } from '../../src/git/worktree.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const repos: ReturnType<typeof makeTmpRepo>[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

function repo(files: Record<string, string>) {
  const r = makeTmpRepo(files, { git: true });
  repos.push(r);
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'base');
  r.git('branch', 'base');
  return r;
}

const head = (dir: string) =>
  execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
const worktrees = (dir: string) =>
  execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'])
    .toString()
    .split('\n')
    .filter((l) => l.startsWith('worktree '));

describe('resolveBase', () => {
  it('returns the merge base of the ref and HEAD', async () => {
    const r = repo({ 'a.txt': 'a' });
    const sha = head(r.dir);
    writeFileSync(join(r.dir, 'b.txt'), 'b');
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'next');
    expect(await resolveBase(r.dir, 'base')).toEqual({ sha, prefix: '' });
  });

  it('reports the subdirectory prefix', async () => {
    const r = repo({ 'pkg/a.txt': 'a' });
    expect((await resolveBase(join(r.dir, 'pkg'), 'base')).prefix).toBe('pkg');
  });

  it('names the fix for a missing ref', async () => {
    const r = repo({ 'a.txt': 'a' });
    await expect(resolveBase(r.dir, 'origin/nope')).rejects.toThrow(/origin\/nope.*fetch-depth: 0/);
  });

  it('fails outside a git repository', async () => {
    const r = makeTmpRepo({ 'a.txt': 'a' });
    repos.push(r);
    await expect(resolveBase(r.dir, 'main')).rejects.toThrow(/git repository/);
  });
});

describe('changedFiles', () => {
  it('lists staged, unstaged, untracked, deleted and renamed paths', async () => {
    const r = repo({
      'keep.txt': 'same',
      'staged file.txt': 'one',
      'unstaged file.txt': 'one',
      'gone file.txt': 'one',
      'old name.txt': 'a fairly long body so rename detection has content to match\n'.repeat(5),
    });
    const { sha } = await resolveBase(r.dir, 'base');
    writeFileSync(join(r.dir, 'staged file.txt'), 'two');
    r.git('add', 'staged file.txt');
    writeFileSync(join(r.dir, 'unstaged file.txt'), 'two');
    writeFileSync(join(r.dir, 'new file.txt'), 'new');
    rmSync(join(r.dir, 'gone file.txt'));
    mkdirSync(join(r.dir, 'sub dir'));
    r.git('mv', 'old name.txt', 'sub dir/new name.txt');

    const { changed, renames } = await changedFiles(r.dir, sha);
    expect([...changed].sort()).toEqual([
      'gone file.txt',
      'new file.txt',
      'old name.txt',
      'staged file.txt',
      'sub dir/new name.txt',
      'unstaged file.txt',
    ]);
    expect([...renames]).toEqual([['old name.txt', 'sub dir/new name.txt']]);
  });

  it('includes committed changes since the merge base', async () => {
    const r = repo({ 'a.txt': 'a' });
    writeFileSync(join(r.dir, 'a.txt'), 'b');
    r.git('commit', '-q', '-am', 'edit');
    const { sha } = await resolveBase(r.dir, 'base');
    expect([...(await changedFiles(r.dir, sha)).changed]).toEqual(['a.txt']);
  });
});

describe('withWorktree', () => {
  it('checks out the commit under the temp dir and removes it afterwards', async () => {
    const r = repo({ 'a.txt': 'base' });
    const sha = head(r.dir);
    writeFileSync(join(r.dir, 'a.txt'), 'head');
    r.git('commit', '-q', '-am', 'head');

    let seen = '';
    const text = await withWorktree(r.dir, sha, async (dir) => {
      seen = dir;
      expect(worktrees(r.dir)).toHaveLength(2);
      return readFileSync(join(dir, 'a.txt'), 'utf8');
    });
    expect(text).toBe('base');
    expect(seen.startsWith(join(realpathSync.native(tmpdir()), 'ctxtruth-'))).toBe(true);
    expect(seen.includes('node_modules')).toBe(false);
    expect(existsSync(seen)).toBe(false);
    expect(existsSync(join(seen, '..'))).toBe(false);
    expect(worktrees(r.dir)).toHaveLength(1);
    expect(readFileSync(join(r.dir, 'a.txt'), 'utf8')).toBe('head');
    expect(execFileSync('git', ['-C', r.dir, 'status', '--porcelain']).toString()).toBe('');
  });

  it('removes the worktree when the callback throws', async () => {
    const r = repo({ 'a.txt': 'a' });
    let seen = '';
    await expect(
      withWorktree(r.dir, head(r.dir), async (dir) => {
        seen = dir;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(seen).not.toBe('');
    expect(existsSync(seen)).toBe(false);
    expect(worktrees(r.dir)).toHaveLength(1);
  });

  it('does not run checkout hooks', async () => {
    const r = repo({ 'a.txt': 'a' });
    const marker = join(r.dir, '..', `hooked-${Date.now()}`).replaceAll('\\', '/');
    const hook = join(r.dir, '.git', 'hooks', 'post-checkout');
    mkdirSync(join(hook, '..'), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\necho ran > '${marker}'\n`);
    chmodSync(hook, 0o755);
    try {
      // The hook does run on a plain worktree add.
      const probe = join(r.dir, '..', `probe-${Date.now()}`);
      r.git('worktree', 'add', '-q', '--detach', probe, 'HEAD');
      r.git('worktree', 'remove', '--force', probe);
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);

      await withWorktree(r.dir, head(r.dir), async () => undefined);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it('removes the worktree and re-raises on SIGINT', async () => {
    const r = repo({ 'a.txt': 'a' });
    const listeners = process.listenerCount('SIGINT');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      let seen = '';
      await withWorktree(r.dir, head(r.dir), async (dir) => {
        seen = dir;
        process.emit('SIGINT', 'SIGINT');
      });
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
      expect(existsSync(seen)).toBe(false);
      expect(worktrees(r.dir)).toHaveLength(1);
      expect(process.listenerCount('SIGINT')).toBe(listeners);
    } finally {
      kill.mockRestore();
    }
  });
});
