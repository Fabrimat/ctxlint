import { mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { git } from './diff.js';

/**
 * Checks out `sha` in a temporary git worktree, runs `fn` on it and removes the worktree.
 *
 * The worktree lives under the OS temp dir, never under the repository or a `node_modules` path
 * (TypeScript treats such paths as external libraries). Hooks and LFS smudging are disabled so
 * the checkout runs no project code. Cleanup only goes through `git worktree remove`.
 */
export async function withWorktree<T>(
  repo: string,
  sha: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const prefix = join(await realpath(tmpdir()), 'ctxtruth-');
  const parent = await mkdtemp(prefix);
  const dir = join(parent, 'base');
  let added = false;
  try {
    await git(
      repo,
      // A hooks dir that does not exist: no post-checkout hook (e.g. husky installs) runs.
      ['-c', `core.hooksPath=${join(parent, 'no-hooks')}`, 'worktree', 'add', '--detach', dir, sha],
      { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' },
    );
    added = true;
    return await fn(dir);
  } finally {
    if (added && parent.startsWith(prefix) && dir.startsWith(parent)) await remove(repo, dir);
    // Non-recursive: only succeeds once the worktree is gone.
    await rmdir(parent).catch(() => undefined);
  }
}

async function remove(repo: string, dir: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await git(repo, ['worktree', 'remove', '--force', dir]);
      await git(repo, ['worktree', 'prune']);
      return;
    } catch {
      // Windows antivirus or open handles can hold files briefly.
      if (attempt === 0) await sleep(500);
    }
  }
  process.stderr.write(`warning: could not remove the base worktree at ${dir}\n`);
}
