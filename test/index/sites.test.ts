import { afterEach, describe, expect, it } from 'vitest';
import { buildFileIndex } from '../../src/index/files.js';
import { findSites, siteOf } from '../../src/index/sites.js';
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
