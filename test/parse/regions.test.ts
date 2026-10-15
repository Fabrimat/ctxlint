import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/parse/index.js';

const regions = [{ begin: /^<!-- BEGIN (\w+) -->$/, end: /^<!-- END \w+ -->$/ }];
const values = (md: string, ignoreRegions = regions) =>
  parseMarkdown(md, 'README.md', { ignoreRegions }).map((c) => c.value);

describe('ignoreRegions', () => {
  it('skips generated sections', () => {
    const md = '`a.ts`\n\n<!-- BEGIN gen -->\n\n`b.ts`\n\n<!-- END gen -->\n\n`c.ts`\n';
    expect(values(md)).toEqual(['a.ts', 'c.ts']);
  });

  it('counts nesting', () => {
    const md =
      '<!-- BEGIN a -->\n\n<!-- BEGIN b -->\n\n<!-- END b -->\n\n`x.ts`\n\n<!-- END a -->\n\n`y.ts`\n';
    expect(values(md)).toEqual(['y.ts']);
  });

  it('runs an unclosed region to the end', () => {
    expect(values('`a.ts`\n\n<!-- BEGIN a -->\n\n`b.ts`\n')).toEqual(['a.ts']);
  });

  it('floors the depth at zero on a stray end', () => {
    expect(values('<!-- END a -->\n\n`a.ts`\n\n<!-- BEGIN a -->\n\n`b.ts`\n')).toEqual(['a.ts']);
  });

  it('handles inline HTML comments in a paragraph', () => {
    const md = 'one `a.ts` <!-- BEGIN a -->\ntwo `b.ts`\nthree <!-- END a --> `c.ts`\n';
    expect(values(md)).toEqual(['a.ts', 'c.ts']);
  });

  it('leaves claims alone when no regex matches', () => {
    const md = '<!-- BEGIN a -->\n\n`a.ts`\n\n<!-- END a -->\n';
    const other = [{ begin: /^<!-- nope -->$/, end: /^<!-- nope end -->$/ }];
    expect(values(md, other)).toEqual(['a.ts']);
    expect(values(md, [])).toEqual(['a.ts']);
  });
});
