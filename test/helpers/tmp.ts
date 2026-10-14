import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Temp directory seeded with `files` (path -> content); `git init` when requested. */
export function makeTmpRepo(files: Record<string, string>, opts: { git?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ctxtruth-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  if (opts.git) execFileSync('git', ['-C', dir, 'init', '-q']);
  return {
    dir,
    git: (...args: string[]) =>
      execFileSync('git', [
        '-C',
        dir,
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ]),
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}
