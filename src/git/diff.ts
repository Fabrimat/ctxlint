import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_BUFFER = 256 * 1024 * 1024;

/** Runs git in `cwd` and returns stdout. */
export async function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { maxBuffer: MAX_BUFFER, env });
  return stdout;
}

const FETCH_HINT =
  'fetch the full history (actions/checkout with `fetch-depth: 0`, or `git fetch origin <branch>`)';

export interface BaseCommit {
  /** Merge base of the ref and HEAD. */
  sha: string;
  /** Repo-relative POSIX prefix of `root` inside the git repository ('' at the top level). */
  prefix: string;
}

/** Resolves the merge base of `ref` and HEAD; throws a message naming the fix when it cannot. */
export async function resolveBase(root: string, ref: string): Promise<BaseCommit> {
  let prefix: string;
  try {
    prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim().replace(/\/$/, '');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        '--changed-only and --new-only need git, which is not installed or not on PATH',
        { cause: err },
      );
    }
    throw new Error(`--changed-only and --new-only need a git repository, ${root} is not one`, {
      cause: err,
    });
  }
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    throw new Error(`cannot resolve base ref \`${ref}\`: ${FETCH_HINT}`);
  }
  try {
    const sha = (await git(root, ['merge-base', ref, 'HEAD'])).trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(sha);
    return { sha, prefix };
  } catch {
    throw new Error(`no merge base between \`${ref}\` and HEAD: ${FETCH_HINT}`);
  }
}

export interface ChangedFiles {
  /** Root-relative POSIX paths changed since the base: both sides of renames, deleted, untracked. */
  changed: Set<string>;
  /** Renamed files, old path -> new path. */
  renames: Map<string, string>;
}

/** Files that differ between `sha` and the working tree (staged, unstaged and untracked). */
export async function changedFiles(root: string, sha: string): Promise<ChangedFiles> {
  const changed = new Set<string>();
  const renames = new Map<string, string>();
  // --relative: paths relative to `root`, which may be a subdirectory of the repository.
  const fields = (
    await git(root, ['diff', '--name-status', '-M', '-z', '--relative', '--no-ext-diff', sha])
  ).split('\0');
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? '';
    if (status === '') continue;
    const path = fields[i++] ?? '';
    changed.add(path);
    if (status.startsWith('R')) {
      const to = fields[i++] ?? '';
      changed.add(to);
      renames.set(path, to);
    }
  }
  const untracked = await git(root, ['ls-files', '-z', '--others', '--exclude-standard']);
  for (const f of untracked.split('\0')) if (f) changed.add(f);
  return { changed, renames };
}
