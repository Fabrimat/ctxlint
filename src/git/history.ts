import { git } from './diff.js';

export interface CommitInfo {
  sha: string;
  /** Author date, ISO 8601. */
  date: string;
  author: string;
  subject: string;
}

/** Throws a message naming the fix when `root` is not a git repository with full history. */
export async function assertFullHistory(root: string): Promise<void> {
  let shallow: string;
  try {
    shallow = (await git(root, ['rev-parse', '--is-shallow-repository'])).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('history needs git, which is not installed or not on PATH', { cause: err });
    }
    throw new Error(`history needs a git repository, ${root} is not one`, { cause: err });
  }
  if (shallow === 'true') {
    throw new Error(
      'history needs the full git history: run `git fetch --unshallow` (or use actions/checkout with `fetch-depth: 0`)',
    );
  }
}

/** The first-parent chain of HEAD, oldest first: on a merge-based repo, one commit per merged PR. */
export async function firstParentChain(root: string): Promise<string[]> {
  return (await git(root, ['rev-list', '--first-parent', '--reverse', 'HEAD']))
    .split('\n')
    .filter(Boolean);
}

export async function commitInfo(root: string, sha: string): Promise<CommitInfo> {
  const out = await git(root, ['show', '-s', '--format=%H%x00%aI%x00%an%x00%s', sha]);
  const [full = sha, date = '', author = '', subject = ''] = out.trim().split('\0');
  return { sha: full, date, author, subject };
}
