import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { FileIndex, Site } from '../types.js';

const DOCUSAURUS = /^docusaurus\.config\.(?:js|ts|mjs|cjs)$/;
const ASTRO = /^astro\.config\.(?:js|ts|mjs|cjs|mts|cts)$/;
/** Dir names a docs app lives in, when it is its own package. */
const DOCS_DIRS = new Set(['docs', 'website', 'site', 'documentation']);
/** Site generators a docs package depends on, by package name. */
const GENERATORS: Readonly<Record<string, string>> = {
  next: 'Next.js',
  nextra: 'Nextra',
  vitepress: 'VitePress',
  '@docusaurus/core': 'Docusaurus',
  astro: 'Astro',
  '@astrojs/starlight': 'Starlight',
  '@nuxt/content': 'Nuxt Content',
  docus: 'Docus',
  undocs: 'undocs',
  'fumadocs-core': 'Fumadocs',
  mintlify: 'Mintlify',
};

async function readJson(root: string, path: string): Promise<Record<string, unknown>> {
  try {
    const json = JSON.parse(await readFile(posix.join(root, path), 'utf8')) as unknown;
    return typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The generator a docs package depends on, if any. */
async function generatorOf(root: string, path: string): Promise<string | undefined> {
  const json = await readJson(root, path);
  const deps = ['dependencies', 'devDependencies'].flatMap((k) => {
    const v = json[k];
    return typeof v === 'object' && v !== null ? Object.keys(v) : [];
  });
  const hit = Object.keys(GENERATORS).find((g) => deps.includes(g));
  return hit === undefined ? undefined : GENERATORS[hit];
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
    else if (name === '.navigation.yml') add(dir, 'Nuxt Content');
    else if (name === 'mint.json') add(dir, 'Mintlify');
    // GitHub does not render MDX: an `index.mdx` home page means a site renders the dir.
    else if (name === 'index.mdx' && DOCS_DIRS.has(posix.basename(dir))) add(dir, 'MDX');
    else if (ASTRO.test(name) && files.hasDir(posix.join(dir, 'src/content/docs'))) {
      add(dir || 'src/content/docs', 'Starlight');
    } else if (name === 'config.json' && segs.slice(0, -1).includes('docs')) {
      // TanStack-style navigation: `docs/config.json`, or one per product (`docs/router/`).
      if (Array.isArray((await readJson(root, f)).sections)) add(dir, 'TanStack-style');
    } else if (name === 'package.json' && DOCS_DIRS.has(posix.basename(dir))) {
      const kind = await generatorOf(root, f);
      if (kind !== undefined) add(dir, kind);
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

const HISTORY: readonly [RegExp, string][] = [
  [/^(?:adrs?|decisions|decision-records|architecture-decisions)$/i, 'decision records'],
  [/^(?:releases|release-notes|changelogs?)$/i, 'release notes'],
  [/^blog$/i, 'blog posts'],
];

/**
 * The dir of a historical record `file` lives in (decision records, release notes, blog posts):
 * they describe the code as it was when written. ponytail: matched by dir name only.
 */
export function historyOf(file: string): { dir: string; reason: string } | undefined {
  const segs = file.split('/').slice(0, -1);
  for (const [i, seg] of segs.entries()) {
    const hit = HISTORY.find(([re]) => re.test(seg));
    if (hit) return { dir: segs.slice(0, i + 1).join('/'), reason: hit[1] };
  }
  return undefined;
}
