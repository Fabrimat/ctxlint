import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { buildFileIndex, listFiles } from '../../src/index/files.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
function repo(files: Record<string, string>, git = true) {
  const r = makeTmpRepo(files, { git });
  cleanups.push(r.cleanup);
  return r;
}

describe('buildFileIndex', () => {
  const idx = buildFileIndex(['README.md', 'src/a/x.ts', 'src/b/x.ts', 'src/Case.ts']);

  it('looks up files and directories case-sensitively', () => {
    expect(idx.hasFile('src/a/x.ts')).toBe(true);
    expect(idx.hasFile('src/a')).toBe(false);
    expect(idx.hasFile('readme.md')).toBe(false);
    expect(idx.hasDir('src')).toBe(true);
    expect(idx.hasDir('src/a')).toBe(true);
    expect(idx.hasDir('SRC')).toBe(false);
    expect(idx.hasDir('src/a/x.ts')).toBe(false);
  });

  it('finds by basename', () => {
    expect(idx.findByBasename('x.ts')).toEqual(['src/a/x.ts', 'src/b/x.ts']);
    expect(idx.findByBasename('nope')).toEqual([]);
  });
});

describe('listFiles (git)', () => {
  it('lists tracked and untracked, drops deleted and gitignored', async () => {
    const r = repo({ 'a.txt': '1', 'gone.txt': '2', '.gitignore': 'dist/\n.env\n' });
    r.git('add', '.');
    r.git('commit', '-qm', 'init');
    rmSync(join(r.dir, 'gone.txt'));
    mkdirSync(join(r.dir, 'dist'));
    writeFileSync(join(r.dir, 'dist/out.js'), '');
    writeFileSync(join(r.dir, '.env'), '');
    writeFileSync(join(r.dir, 'new.txt'), '');
    expect((await listFiles(r.dir)).sort()).toEqual(['.gitignore', 'a.txt', 'new.txt']);
  });

  it('returns paths relative to a subdirectory root', async () => {
    const r = repo({ 'top.txt': '', 'sub/a.txt': '', 'sub/deep/b.txt': '' });
    expect((await listFiles(join(r.dir, 'sub'))).sort()).toEqual(['a.txt', 'deep/b.txt']);
  });
});

describe('listFiles (no git)', () => {
  it('walks the tree skipping .git and node_modules', async () => {
    const r = repo(
      { 'a.txt': '', 'sub/b.txt': '', 'node_modules/x/i.js': '', '.git/HEAD': '' },
      false,
    );
    expect((await listFiles(r.dir)).sort()).toEqual(['a.txt', 'sub/b.txt']);
  });
});
