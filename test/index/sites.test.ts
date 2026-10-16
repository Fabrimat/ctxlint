import { afterEach, describe, expect, it } from 'vitest';
import { buildFileIndex } from '../../src/index/files.js';
import { findSites, historyOf, siteOf } from '../../src/index/sites.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

async function sites(files: Record<string, string>) {
  const repo = makeTmpRepo(files);
  cleanups.push(repo.cleanup);
  return findSites(repo.dir, buildFileIndex(Object.keys(files)));
}

describe('findSites', () => {
  it.each([
    ['docs/.vitepress/config.ts', 'docs', 'VitePress'],
    ['website/.vuepress/config.js', 'website', 'VuePress'],
    ['website/docusaurus.config.ts', 'website', 'Docusaurus'],
    ['docusaurus.config.js', 'docs', 'Docusaurus'],
    ['mkdocs.yml', 'docs', 'MkDocs'],
    ['guide/book.toml', 'guide', 'mdBook'],
    ['docs/_config.yml', 'docs', 'Jekyll'],
  ])('%s marks %s as a %s site', async (marker, dir, kind) => {
    expect(await sites({ [marker]: '', 'docs/a.md': '', [`${dir}/b.md`]: '' })).toEqual([
      { dir, kind },
    ]);
  });

  it('needs src/content/docs next to an Astro config', async () => {
    const starlight = { 'site/astro.config.mjs': '', 'site/src/content/docs/a.md': '' };
    expect(await sites(starlight)).toEqual([{ dir: 'site', kind: 'Starlight' }]);
    expect(await sites({ 'examples/astro/astro.config.mjs': '', 'docs/a.md': '' })).toEqual([]);
  });

  it('needs a navigation `sections` array in docs/config.json', async () => {
    const nav = JSON.stringify({ sections: [] });
    expect(await sites({ 'docs/config.json': nav, 'docs/a.md': '' })).toEqual([
      { dir: 'docs', kind: 'TanStack-style' },
    ]);
    expect(await sites({ 'docs/config.json': '{"port":1}', 'docs/a.md': '' })).toEqual([]);
    expect(await sites({ 'docs/config.json': 'not json', 'docs/a.md': '' })).toEqual([]);
  });

  it('finds a TanStack-style navigation per product under docs/', async () => {
    const nav = JSON.stringify({ sections: [] });
    expect(await sites({ 'docs/router/config.json': nav, 'docs/start/config.json': nav })).toEqual([
      { dir: 'docs/router', kind: 'TanStack-style' },
      { dir: 'docs/start', kind: 'TanStack-style' },
    ]);
    expect(await sites({ 'src/config.json': nav })).toEqual([]);
  });

  it('finds Nuxt Content and Mintlify markers', async () => {
    expect(await sites({ 'docs/.navigation.yml': '' })).toEqual([
      { dir: 'docs', kind: 'Nuxt Content' },
    ]);
    expect(await sites({ 'docs/mint.json': '{}' })).toEqual([{ dir: 'docs', kind: 'Mintlify' }]);
  });

  it('finds a docs package that depends on a site generator', async () => {
    const pkg = (deps: Record<string, string>) => JSON.stringify({ devDependencies: deps });
    expect(await sites({ 'docs/package.json': pkg({ next: '15' }) })).toEqual([
      { dir: 'docs', kind: 'Next.js' },
    ]);
    expect(await sites({ 'website/package.json': pkg({ undocs: '1' }) })).toEqual([
      { dir: 'website', kind: 'undocs' },
    ]);
    // A docs package without a generator, or a generator outside a docs dir, is not a site.
    expect(await sites({ 'docs/package.json': pkg({ vue: '3' }) })).toEqual([]);
    expect(await sites({ 'apps/web/package.json': pkg({ next: '15' }) })).toEqual([]);
  });

  it('never makes the repo root a site, and folds nested sites', async () => {
    expect(await sites({ '.vitepress/config.ts': '', 'book.toml': '', 'a.md': '' })).toEqual([]);
    const nested = { 'docs/.vitepress/config.ts': '', 'docs/api/_config.yml': '' };
    expect(await sites(nested)).toEqual([{ dir: 'docs', kind: 'VitePress' }]);
  });

  it('finds the site of a file', () => {
    const list = [{ dir: 'docs', kind: 'VitePress' }];
    expect(siteOf('docs/guide/a.md', list)).toEqual(list[0]);
    expect(siteOf('docs-old/a.md', list)).toBeUndefined();
    expect(siteOf('README.md', list)).toBeUndefined();
  });
});

describe('MDX sites and historical records', () => {
  it('finds a docs dir with an index.mdx home page', async () => {
    expect(await sites({ 'docs/index.mdx': '', 'docs/a.md': '' })).toEqual([
      { dir: 'docs', kind: 'MDX' },
    ]);
    expect(await sites({ 'src/index.mdx': '' })).toEqual([]);
  });

  it('finds decision records, release notes and blog posts by their dir', () => {
    expect(historyOf('docs/architecture docs/adrs/ADR 1 - x.md')).toEqual({
      dir: 'docs/architecture docs/adrs',
      reason: 'decision records',
    });
    expect(historyOf('docs/releases/v8.md')).toEqual({
      dir: 'docs/releases',
      reason: 'release notes',
    });
    expect(historyOf('docs/blog/2024.md')?.reason).toBe('blog posts');
    expect(historyOf('docs/guide/releases.md')).toBeUndefined();
    expect(historyOf('README.md')).toBeUndefined();
  });
});
