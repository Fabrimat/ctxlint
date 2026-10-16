import { describe, expect, it } from 'vitest';
import { parseMarkdown, type ParseOptions } from '../../src/parse/index.js';
import { fenced } from '../parse/helpers.js';

const matchers: ParseOptions['matchers'] = [
  { id: 'a/ids', match: { inlineCode: /^src\/ids\// } },
  { id: 'a/cli', match: { commands: ['fakecli', 'npm'], fences: ['FakeConf'] } },
  { id: 'b/cli', match: { commands: ['fakecli', 'other'], inlineCode: /^src\// } },
  { id: 'b/links', match: { links: /^fake:/ } },
];

const parse = (md: string, m = matchers) =>
  parseMarkdown(md, 'AGENTS.md', { matchers: m }).map(({ kind, value, meta, line, col }) => ({
    kind,
    value,
    meta,
    line,
    col,
  }));
const custom = (check: string, matched: string, value: string, extra = {}) => ({
  kind: 'custom',
  value,
  meta: { check, matched, ...extra },
});

describe('plugin matchers', () => {
  it('take inline code before paths and symbols; the first check in order wins', () => {
    expect(parse('See `src/ids/a.ts`, `src/x.ts` and `Cfg.bar`.')).toMatchObject([
      custom('a/ids', 'inline-code', 'src/ids/a.ts'),
      custom('b/cli', 'inline-code', 'src/x.ts'),
      { kind: 'symbol', value: 'Cfg.bar' },
    ]);
  });

  it('adopt a command in inline code starting with the binary', () => {
    expect(parse('Run `fakecli build --x` or `FOO=1 fakecli.cmd go`.')).toMatchObject([
      { ...custom('a/cli', 'command', 'fakecli build --x'), col: 6 },
      custom('a/cli', 'command', 'fakecli.cmd go'),
    ]);
  });

  it('adopt a package manager before its built-in extraction', () => {
    expect(parse('`npm run build`')).toEqual([
      { ...custom('a/cli', 'command', 'npm run build'), line: 1, col: 2 },
    ]);
  });

  it('adopt commands in shell fences, to the end of their segment, and not as commands', () => {
    const md = fenced('sh', 'sudo fakecli build --x "a b" && other y; ls | git status');
    expect(parse(md)).toEqual([
      { ...custom('a/cli', 'command', 'fakecli build --x "a b"'), line: 2, col: 6 },
      { ...custom('b/cli', 'command', 'other y'), line: 2, col: 33 },
      { kind: 'command', value: 'ls', meta: undefined, line: 2, col: 42 },
      { kind: 'command', value: 'git', meta: undefined, line: 2, col: 47 },
    ]);
    expect(parse(fenced('sh', '(fakecli build)'))).toMatchObject([
      custom('a/cli', 'command', 'fakecli build'),
    ]);
  });

  it('take a whole fence by language, case-insensitively, before snippets', () => {
    expect(parse(fenced('fakeconf', 'a=1', 'b=2'))).toEqual([
      { ...custom('a/cli', 'fence', 'a=1\nb=2', { lang: 'fakeconf' }), line: 2, col: 1 },
    ]);
    const ts = parse(fenced('ts', 'x'), [{ id: 'a/ts', match: { fences: ['ts'] } }]);
    expect(ts).toMatchObject([custom('a/ts', 'fence', 'x', { lang: 'ts' })]);
  });

  it('take links before path links', () => {
    expect(parse('[a](fake:thing) [b](docs/x.md)')).toMatchObject([
      custom('b/links', 'link', 'fake:thing'),
      { kind: 'path', value: 'docs/x.md' },
    ]);
  });

  it('leave everything else to the built-ins', () => {
    expect(parse('`npm run build`', [])).toMatchObject([{ kind: 'script', value: 'build' }]);
  });
});
