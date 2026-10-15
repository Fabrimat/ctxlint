import { readdir } from 'node:fs/promises';
import { posix } from 'node:path';
import { git as runGit } from '../git/diff.js';
import type { FileIndex } from '../types.js';

export function buildFileIndex(paths: readonly string[]): FileIndex {
  const files = [...new Set(paths)];
  const fileSet = new Set(files);
  const dirs = new Set<string>(files.length > 0 ? [''] : []);
  const byBasename = new Map<string, string[]>();
  for (const f of files) {
    for (let d = posix.dirname(f); d !== '.' && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
    const base = posix.basename(f);
    const list = byBasename.get(base);
    if (list) list.push(f);
    else byBasename.set(base, [f]);
  }
  return {
    files,
    hasFile: (p) => fileSet.has(p),
    hasDir: (p) => dirs.has(p),
    findByBasename: (name) => [...(byBasename.get(name) ?? [])],
  };
}

async function git(root: string, args: string[]): Promise<string[]> {
  return (await runGit(root, args)).split('\0').filter(Boolean);
}

async function listWithGit(root: string): Promise<string[]> {
  const listed = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const deleted = await git(root, ['ls-files', '-z', '--deleted']);
  const gone = new Set(deleted);
  return listed.filter((f) => !gone.has(f));
}

// ponytail: no .gitignore handling outside git; only .git and node_modules are skipped
async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(rel ? `${root}/${rel}` : root, { withFileTypes: true });
  for (const e of entries) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name !== '.git' && e.name !== 'node_modules') out.push(...(await walk(root, path)));
    } else if (e.isFile()) {
      out.push(path);
    }
  }
  return out;
}

export async function listFiles(root: string): Promise<string[]> {
  try {
    return await listWithGit(root);
  } catch {
    return walk(root);
  }
}
