import { execFileSync } from 'node:child_process';
import { rmdirSync } from 'node:fs';
import { mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { clean, git } from './diff.js';

/** Moves the temporary worktree to another commit (same hooks and LFS guards as the first checkout). */
export type Checkout = (sha: string) => Promise<void>;

/**
 * Checks out `sha` in a temporary git worktree, runs `fn` on it and removes the worktree. `fn`
 * can move the worktree to other commits with `checkout`, so a history walk pays for one worktree.
 *
 * The worktree lives under the OS temp dir, never under the repository or a `node_modules` path
 * (TypeScript treats such paths as external libraries). Hooks and LFS smudging are disabled so
 * the checkout runs no project code. Cleanup only goes through `git worktree remove`.
 */
export async function withWorktree<T>(
  repo: string,
  sha: string,
  fn: (dir: string, checkout: Checkout) => Promise<T>,
): Promise<T> {
  const prefix = join(await realpath(tmpdir()), 'ctxtruth-');
  const parent = await mkdtemp(prefix);
  const dir = join(parent, 'base');
  // A hooks dir that does not exist: no post-checkout hook (e.g. husky installs) runs.
  const noHooks = ['-c', `core.hooksPath=${join(parent, 'no-hooks')}`];
  const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' };
  let added = false;
  // Ctrl-C mid-walk must not leave a worktree registered in the user's repository.
  const onSignal = (signal: NodeJS.Signals): void => {
    try {
      execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', dir], {
        env: clean(process.env),
        stdio: 'ignore',
      });
      rmdirSync(parent);
    } catch {
      process.stderr.write(`warning: could not remove the base worktree at ${dir}
`);
    }
    process.kill(process.pid, signal);
  };
  try {
    await git(repo, [...noHooks, 'worktree', 'add', '--detach', dir, sha], env);
    added = true;
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    // --force only ever runs inside the temporary worktree: it discards nothing of the user's.
    const checkout: Checkout = async (to) => {
      await git(dir, [...noHooks, 'checkout', '--quiet', '--force', '--detach', to], env);
    };
    return await fn(dir, checkout);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
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
