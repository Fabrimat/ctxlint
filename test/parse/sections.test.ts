import { describe, expect, it } from 'vitest';
import { sectionsOf } from '../../src/parse/sections.js';

describe('sectionsOf', () => {
  it('gives each heading its own body, nested paths and a preamble', () => {
    const md = ['intro', '', '# A', 'a', '## B', 'b', '### C', 'c', '## D', 'd', ''].join('\n');
    expect(sectionsOf(md)).toEqual([
      { path: [], startLine: 1, endLine: 2 },
      { path: ['A'], startLine: 3, endLine: 4 },
      { path: ['A', 'B'], startLine: 5, endLine: 6 },
      { path: ['A', 'B', 'C'], startLine: 7, endLine: 8 },
      { path: ['A', 'D'], startLine: 9, endLine: 10 },
    ]);
  });

  it('keeps duplicate headings apart by line and omits an empty preamble', () => {
    const md = '# Setup\nx\n# Setup\ny';
    expect(sectionsOf(md)).toEqual([
      { path: ['Setup'], startLine: 1, endLine: 2 },
      { path: ['Setup'], startLine: 3, endLine: 4 },
    ]);
  });

  it('counts CRLF lines and skips frontmatter and fenced #', () => {
    const md = '---\r\ntitle: x\r\n---\r\n# A\r\n```sh\r\n# not a heading\r\n```\r\n## B\r\nb\r\n';
    expect(sectionsOf(md)).toEqual([
      { path: [], startLine: 1, endLine: 3 },
      { path: ['A'], startLine: 4, endLine: 7 },
      { path: ['A', 'B'], startLine: 8, endLine: 9 },
    ]);
  });

  it('treats a doc without headings as one preamble', () => {
    expect(sectionsOf('one\ntwo\n')).toEqual([{ path: [], startLine: 1, endLine: 2 }]);
  });
});
