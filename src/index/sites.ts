import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { FileIndex, Site } from '../types.js';

const DOCUSAURUS = /^docusaurus\.config\.(?:js|ts|mjs|cjs)$/;
const ASTRO = /^astro\.config\.(?:js|ts|mjs|cjs|mts|cts)$/;

/** TanStack-style `docs/config.json`: a JSON navigation with a `sections` array. */
async function isDocsConfig(root: string, path: string): Promise<boolean> {
  try {
    const json = JSON.parse(await readFile(posix.join(root, path), 'utf8')) as unknown;
    return (
      typeof json === 'object' &&
      json !== null &&
      Array.isArray((json as Record<string, unknown>).sections)
    );
  } catch {
    return false;
  }
}

/**
 * Documentation-site roots, found by their generator's marker. Their pages describe the users'
 * projects, not this repository. A marker at the repo root never makes the whole repo a site:
 * only Docusaurus and MkDocs point at `docs/` from there.
 * ponytail: default layouts only (MkDocs `docs_dir`, Docusaurus `path` are not read).
 */
export async function findSites(root: string, files: FileIndex): Promise<Site[]> {
  const found = new Map<string, string>();
  const add = (dir: string, kind: string): void => {
    if (dir !== '' && files.hasDir(dir) && !found.has(dir)) found.set(dir, kind);
  };
  for (const f of files.files) {
    const segs = f.split('/');
    const gen = segs.findIndex((s) => s === '.vitepress' || s === '.vuepress');
    if (gen >= 0) {
      add(segs.slice(0, gen).join('/'), segs[gen] === '.vitepress' ? 'VitePress' : 'VuePress');
      continue;
    }
    const name = segs.at(-1) ?? '';
    const dir = segs.slice(0, -1).join('/');
    if (DOCUSAURUS.test(name)) add(dir || 'docs', 'Docusaurus');
    else if (name === 'mkdocs.yml') add(dir || 'docs', 'MkDocs');
    else if (name === 'book.toml') add(dir, 'mdBook');
    else if (name === '_config.yml') add(dir, 'Jekyll');
    else if (ASTRO.test(name) && files.hasDir(posix.join(dir, 'src/content/docs'))) {
      add(dir || 'src/content/docs', 'Starlight');
    } else if (name === 'config.json' && posix.basename(dir) === 'docs') {
      if (await isDocsConfig(root, f)) add(dir, 'TanStack-style');
    }
  }
  const dirs = [...found.keys()];
  // A site nested in another is part of it.
  return dirs
    .filter((d) => !dirs.some((o) => o !== d && d.startsWith(`${o}/`)))
    .sort()
    .map((dir) => ({ dir, kind: found.get(dir) as string }));
}

/** The innermost site containing `file`, if any. */
export function siteOf(file: string, sites: readonly Site[]): Site | undefined {
  return sites.find((s) => file.startsWith(`${s.dir}/`));
}
