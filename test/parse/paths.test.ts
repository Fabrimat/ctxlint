import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/parse/index.js';
import { claim } from './helpers.js';

const fromInline = (code: string) =>
  parseMarkdown(`\`${code}\``, 'AGENTS.md').map(({ value, meta }) => ({ value, meta }));

describe('inline code paths: accepted', () => {
  it.each([
    ['src/index.ts', { value: 'src/index.ts' }],
    ['./scripts/run.sh', { value: './scripts/run.sh' }],
    ['../lib/a.js', { value: '../lib/a.js' }],
    ['package.json', { value: 'package.json' }],
    ['pnpm-lock.yaml', { value: 'pnpm-lock.yaml' }],
    ['src/a.ts:12', { value: 'src/a.ts' }],
    ['src/a.ts:12:3', { value: 'src/a.ts' }],
    ['src/a.ts#L12', { value: 'src/a.ts' }],
    ['src/a.ts#L12-L20', { value: 'src/a.ts' }],
    ['src/a.ts,', { value: 'src/a.ts' }],
    ['a.ts:12', { value: 'a.ts' }],
    ['/docs/api.md', { value: 'docs/api.md', meta: { anchor: 'root' } }],
    ['src/', { value: 'src', meta: { dir: 'true' } }],
    ['/src/', { value: 'src', meta: { anchor: 'root', dir: 'true' } }],
    ['.eslintrc.json', { value: '.eslintrc.json' }],
    ['.github/ci.yml', { value: '.github/ci.yml' }],
  ])('%s', (code, expected) => {
    expect(fromInline(code)).toEqual([{ meta: undefined, ...expected }]);
  });
});

describe('inline code paths: rejected', () => {
  it.each([
    ['scoped package', '@scope/pkg'],
    ['scoped package with file', '@types/node/index.d.ts'],
    ['URL', 'https://example.org/a.md'],
    ['scheme', 'file:a.md'],
    ['leading dash', '-x/y.ts'],
    ['home', '~/notes/a.md'],
    ['variable', '$HOME/a.md'],
    ['glob star', 'src/*.ts'],
    ['glob question', 'src/?.ts'],
    ['glob brackets', 'src/[id].ts'],
    ['glob braces', 'src/{a,b}.ts'],
    ['placeholder angle', '<dir>/index.ts'],
    ['placeholder path/to', 'path/to/file.ts'],
    ['placeholder your-', 'your-app/main.ts'],
    ['placeholder my-', 'my-lib/main.ts'],
    ['placeholder xxx', 'xxx/main.ts'],
    ['placeholder foo/bar', 'foo/bar'],
    ['placeholder example', 'examples/a.ts'],
    ['version', '1.2.3'],
    ['v-version', 'v1.0'],
    ['http', 'http/a.ts'],
    ['root only', '/'],
    ['dot only', '.'],
    ['whitespace', 'src/a b.ts'],
    ['bare word', 'readme'],
    ['unknown extension', 'run.exe'],
    ['protocol-relative', '//cdn.example/a.js'],
    ['extension', '.json'],
    ['declaration extension', '.d.ts'],
    ['module extension', '.mjs'],
    ['test extension', '.test.ts'],
  ])('%s', (_name, code) => {
    expect(fromInline(code)).toEqual([]);
  });
});

describe('link paths', () => {
  it('extracts relative links with the node start position', () => {
    expect(parseMarkdown('See [guide](docs/guide.md) now.', 'AGENTS.md')).toEqual([
      claim({ kind: 'path', value: 'docs/guide.md', line: 1, col: 5, source: 'link' }),
    ]);
  });

  it('strips anchors and queries and decodes percent-encoding', () => {
    expect(
      parseMarkdown(
        [
          '[a](docs/guide.md#intro)',
          '[b](docs/my%20file.md?raw=1)',
          '[c](docs/guide.md?x=1#y)',
        ].join('\n\n'),
        'AGENTS.md',
      ),
    ).toEqual([
      claim({ kind: 'path', value: 'docs/guide.md', line: 1, col: 1, source: 'link' }),
      claim({ kind: 'path', value: 'docs/my file.md', line: 3, col: 1, source: 'link' }),
      claim({ kind: 'path', value: 'docs/guide.md', line: 5, col: 1, source: 'link' }),
    ]);
  });

  it('applies root-anchor and directory rules', () => {
    expect(parseMarkdown('[a](/docs/) and [b](src/)', 'AGENTS.md')).toEqual([
      claim({
        kind: 'path',
        value: 'docs',
        line: 1,
        col: 1,
        source: 'link',
        meta: { anchor: 'root', dir: 'true' },
      }),
      claim({
        kind: 'path',
        value: 'src',
        line: 1,
        col: 17,
        source: 'link',
        meta: { dir: 'true' },
      }),
    ]);
  });

  it('extracts images and link definitions', () => {
    expect(parseMarkdown('![logo](./img/logo.png)\n\n[ref]: ./docs/ref.md', 'AGENTS.md')).toEqual([
      claim({ kind: 'path', value: './img/logo.png', line: 1, col: 1, source: 'link' }),
      claim({ kind: 'path', value: './docs/ref.md', line: 3, col: 1, source: 'link' }),
    ]);
  });

  it('ignores absolute URLs, fragments, mailto and protocol-relative links', () => {
    const md = [
      '[a](https://example.org/a.md)',
      '[b](#section)',
      '[c](mailto:me@example.org)',
      '[d](//cdn.example/a.js)',
      '<https://example.org/b.md>',
      'www.example.org/c.md',
    ].join('\n\n');
    expect(parseMarkdown(md, 'AGENTS.md')).toEqual([]);
  });

  it('accepts extensionless link targets', () => {
    expect(parseMarkdown('[license](LICENSE)', 'AGENTS.md')).toEqual([
      claim({ kind: 'path', value: 'LICENSE', line: 1, col: 1, source: 'link' }),
    ]);
  });
});

describe('prose paths', () => {
  const text = 'See src/a.ts and docs/readme.md. Also and/or a.ts src/ src/*.ts https://x.io/a.md';

  it('is off by default', () => {
    expect(parseMarkdown(text, 'AGENTS.md')).toEqual([]);
  });

  it('extracts slash-containing tokens with a known extension when enabled', () => {
    expect(parseMarkdown(text, 'AGENTS.md', { prose: true })).toEqual([
      claim({ kind: 'path', value: 'src/a.ts', line: 1, col: 5, source: 'prose' }),
      claim({ kind: 'path', value: 'docs/readme.md', line: 1, col: 18, source: 'prose' }),
    ]);
  });

  it('reports exact positions on later lines', () => {
    expect(parseMarkdown('first line\nsee lib/x.ts', 'AGENTS.md', { prose: true })).toEqual([
      claim({ kind: 'path', value: 'lib/x.ts', line: 2, col: 5, source: 'prose' }),
    ]);
  });
});

describe('strong and weak path shapes', () => {
  it.each([
    ['origin/main', { value: 'origin/main', meta: { shape: 'weak' } }],
    ['lodash/fp', { value: 'lodash/fp', meta: { shape: 'weak' } }],
    ['react-dom/client', { value: 'react-dom/client', meta: { shape: 'weak' } }],
    ['owner/repo', { value: 'owner/repo', meta: { shape: 'weak' } }],
    ['text/html', { value: 'text/html', meta: { shape: 'weak' } }],
    ['and/or', { value: 'and/or', meta: { shape: 'weak' } }],
    ['TCP/IP', { value: 'TCP/IP', meta: { shape: 'weak' } }],
    ['n/a', { value: 'n/a', meta: { shape: 'weak' } }],
    ['v1/v2', { value: 'v1/v2', meta: { shape: 'weak' } }],
    ['src/components', { value: 'src/components', meta: { shape: 'weak' } }],
    ['src/index.ts', { value: 'src/index.ts' }],
    ['src/components/', { value: 'src/components', meta: { dir: 'true' } }],
    ['./build', { value: './build' }],
    ['../shared', { value: '../shared' }],
    ['/src/', { value: 'src', meta: { anchor: 'root', dir: 'true' } }],
    ['/docs/x.md', { value: 'docs/x.md', meta: { anchor: 'root' } }],
  ])('%s', (code, expected) => {
    expect(fromInline(code)).toEqual([{ meta: undefined, ...expected }]);
  });

  it.each([
    '/api/users',
    '/usr/bin/node',
    '1/2',
    'true/false/',
    'e.g./i.e.',
    'a//b',
    'a/b c',
    'a/ü.ts',
    'a/b:c/d',
  ])('drops %s', (code) => {
    expect(fromInline(code)).toEqual(
      code === 'true/false/' ? [{ value: 'true/false', meta: { dir: 'true' } }] : [],
    );
  });

  it('keeps link targets unchanged', () => {
    expect(parseMarkdown('[a](origin/main)', 'AGENTS.md')).toEqual([
      claim({ kind: 'path', value: 'origin/main', line: 1, col: 1, source: 'link' }),
    ]);
  });
});

describe('prose and links', () => {
  it('does not scan link text for prose claims', () => {
    expect(
      parseMarkdown('[src/a.ts](src/a.ts) and lib/b.ts', 'AGENTS.md', { prose: true }),
    ).toEqual([
      claim({ kind: 'path', value: 'src/a.ts', line: 1, col: 1, source: 'link' }),
      claim({ kind: 'path', value: 'lib/b.ts', line: 1, col: 26, source: 'prose' }),
    ]);
  });
});

describe('paths described as generated', () => {
  const generated = (md: string) =>
    parseMarkdown(md, 'AGENTS.md')
      .filter((c) => c.kind === 'path')
      .map((c) => [c.value, c.meta?.generated ?? '']);

  it('marks paths on a line or paragraph that says they are generated', () => {
    const md = [
      '- `docs/names.json` is generated by `pnpm docs:contributors`',
      '- `LICENSE.md` is rewritten',
      '  when deps change; it is the build output of `src/a.ts`',
      '- `out/report.html` is written by the reporter',
      '',
      'Create `src/new.ts` first.',
      '',
      '- `src/index.ts` is the entry point',
      '',
      '```sh',
      './scripts/gen.sh # creates dist/x.js',
      '```',
    ].join('\n');
    expect(generated(md)).toEqual([
      ['docs/names.json', 'true'],
      ['LICENSE.md', 'true'],
      ['src/a.ts', 'true'],
      ['out/report.html', 'true'],
      ['src/new.ts', ''],
      ['src/index.ts', ''],
      ['./scripts/gen.sh', ''],
    ]);
  });
});
