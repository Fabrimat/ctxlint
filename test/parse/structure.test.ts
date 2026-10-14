import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/parse/index.js';
import { claim, fenced } from './helpers.js';

describe('inline code positions', () => {
  it('points at the code text for single backticks', () => {
    expect(parseMarkdown('Run `src/a.ts` now', 'AGENTS.md')).toEqual([
      claim({ kind: 'path', value: 'src/a.ts', line: 1, col: 6 }),
    ]);
  });

  it('accounts for double backtick fences and padding', () => {
    expect(parseMarkdown('Run ``src/a.ts`` now', 'AGENTS.md')[0]).toEqual(
      claim({ kind: 'path', value: 'src/a.ts', line: 1, col: 7 }),
    );
    expect(parseMarkdown('Run `` src/a.ts `` now', 'AGENTS.md')[0]).toEqual(
      claim({ kind: 'path', value: 'src/a.ts', line: 1, col: 8 }),
    );
  });

  it('works inside list items and later lines', () => {
    expect(parseMarkdown('Intro\n\n- see `src/a.ts`', 'AGENTS.md')).toEqual([
      claim({ kind: 'path', value: 'src/a.ts', line: 3, col: 8 }),
    ]);
  });

  it('omits meta when empty and copies the file path', () => {
    const [c] = parseMarkdown('`src/a.ts`', 'docs/x.md');
    expect(c).toEqual({
      kind: 'path',
      value: 'src/a.ts',
      file: 'docs/x.md',
      line: 1,
      col: 2,
      section: [],
      source: 'inline-code',
    });
    expect(c && 'meta' in c).toBe(false);
  });
});

describe('sections', () => {
  it('tracks the nested heading stack', () => {
    const md = [
      'before `a/zero.ts`',
      '# One',
      '`a/one.ts`',
      '## Two',
      '### Three',
      '`a/three.ts`',
      '## Two B',
      '`a/twob.ts`',
      '# Other',
      '`a/other.ts`',
    ].join('\n\n');
    expect(parseMarkdown(md, 'AGENTS.md').map((c) => [c.value, c.section])).toEqual([
      ['a/zero.ts', []],
      ['a/one.ts', ['One']],
      ['a/three.ts', ['One', 'Two', 'Three']],
      ['a/twob.ts', ['One', 'Two B']],
      ['a/other.ts', ['Other']],
    ]);
  });

  it('uses the plain text of headings with inline markup', () => {
    expect(parseMarkdown('## Using `pnpm` **now**\n\n`a/b.ts`', 'AGENTS.md')[0]?.section).toEqual([
      'Using pnpm now',
    ]);
  });
});

describe('frontmatter', () => {
  it('blanks the block but keeps line numbers', () => {
    const md = ['---', 'title: x', 'globs: `src/fm.ts`', '---', '# H', '`src/b.ts`'].join('\n');
    expect(parseMarkdown(md, 'rules.mdc')).toEqual([
      claim({
        kind: 'path',
        value: 'src/b.ts',
        line: 6,
        col: 2,
        file: 'rules.mdc',
        section: ['H'],
      }),
    ]);
  });

  it('handles CRLF and empty frontmatter', () => {
    expect(parseMarkdown('---\r\n---\r\n`src/b.ts`', 'AGENTS.md')).toEqual([
      claim({ kind: 'path', value: 'src/b.ts', line: 3, col: 2 }),
    ]);
  });

  it('does not treat a later thematic break as frontmatter', () => {
    expect(
      parseMarkdown('`a/x.ts`\n\n---\n\n`a/y.ts`\n\n---', 'AGENTS.md').map((c) => c.value),
    ).toEqual(['a/x.ts', 'a/y.ts']);
  });
});

describe('ignore markers', () => {
  it('ctxtruth-ignore skips only the next block', () => {
    const md = ['<!-- ctxtruth-ignore -->', 'See `src/gone.ts`.', '', 'See `src/kept.ts`.'].join(
      '\n',
    );
    expect(parseMarkdown(md, 'AGENTS.md')).toEqual([
      claim({ kind: 'path', value: 'src/kept.ts', line: 4, col: 6 }),
    ]);
  });

  it('ctxtruth-ignore also skips a fenced block and keeps later ones', () => {
    const md = [
      '<!-- ctxtruth-ignore -->',
      fenced('sh', 'npm run gone'),
      '',
      fenced('sh', 'npm run kept'),
    ].join('\n');
    expect(parseMarkdown(md, 'AGENTS.md')).toEqual([
      claim({
        kind: 'script',
        value: 'kept',
        line: 7,
        col: 9,
        meta: { pm: 'npm' },
        source: 'fence',
      }),
    ]);
  });

  it('disable/enable skips the lines in between', () => {
    const md = [
      '`a/one.ts`',
      '<!-- ctxtruth-disable -->',
      '`a/two.ts`',
      '<!-- ctxtruth-enable -->',
      '`a/three.ts`',
    ].join('\n\n');
    expect(parseMarkdown(md, 'AGENTS.md').map((c) => [c.value, c.line])).toEqual([
      ['a/one.ts', 1],
      ['a/three.ts', 9],
    ]);
  });

  it('disable without enable runs to the end of the file', () => {
    const md = ['`a/one.ts`', '<!-- ctxtruth-disable -->', '`a/two.ts`'].join('\n\n');
    expect(parseMarkdown(md, 'AGENTS.md').map((c) => c.value)).toEqual(['a/one.ts']);
  });

  it('markers are case-sensitive', () => {
    const md = ['<!-- CTXTRUTH-IGNORE -->', '`a/one.ts`'].join('\n');
    expect(parseMarkdown(md, 'AGENTS.md').map((c) => c.value)).toEqual(['a/one.ts']);
  });
});
