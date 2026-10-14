import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../../src/run.js';
import { formatReport } from '../../src/report/index.js';
import { compared, fail, opts, pass, report } from './make.js';

const footer = [
  '<details><summary>Freshness per file</summary>',
  '',
  '- `AGENTS.md`: 50% (1/2)',
  '',
  '</details>',
  '',
  '<sub>ctxtruth 1.2.3</sub>',
  '',
];

describe('markdown format', () => {
  it('reports a clean run without a comparison', () => {
    expect(formatReport(report([pass()]), 'markdown', opts)).toBe(
      [
        '<!-- ctxtruth-report -->',
        '### ctxtruth',
        '',
        '✅ No documentation drift found.',
        '',
        '<details><summary>Freshness per file</summary>',
        '',
        '- `AGENTS.md`: 100% (1/1)',
        '',
        '</details>',
        '',
        '<sub>ctxtruth 1.2.3</sub>',
        '',
      ].join('\n'),
    );
  });

  it('says no drift was introduced with a comparison', () => {
    const r = report([pass()]);
    r.comparison = {
      base: 'main',
      baseSha: 'a',
      introduced: 0,
      existing: 0,
      fixed: 0,
      notComparable: 0,
    };
    expect(formatReport(r, 'markdown', opts)).toContain(
      '\n✅ No documentation drift introduced.\n',
    );
  });

  it('lists findings with plain locations', () => {
    const r = report([pass(), fail({ suggestion: 'src/new.ts' })]);
    expect(formatReport(r, 'markdown', opts)).toBe(
      [
        '<!-- ctxtruth-report -->',
        '### ctxtruth',
        '',
        '**1** documentation claim is false (1 error, 0 warnings).',
        '',
        '**AGENTS.md**',
        '',
        '| Location | Severity | Check | Problem |',
        '| --- | --- | --- | --- |',
        '| `AGENTS.md:2` | 🔴 error | paths | Path `src/gone.ts` does not exist<br>Suggestion: `src/new.ts` |',
        '',
        ...footer,
      ].join('\n'),
    );
  });

  it('links locations when linkBase is set', () => {
    const out = formatReport(
      report([fail({ file: 'docs/a.md', line: 7 })], ['docs/a.md']),
      'markdown',
      {
        ...opts,
        linkBase: 'https://github.com/o/r/blob/abc',
      },
    );
    expect(out).toContain('[`docs/a.md:7`](https://github.com/o/r/blob/abc/docs/a.md#L7)');
  });

  it('escapes pipes and newlines in cells', () => {
    const out = formatReport(
      report([fail({ message: 'a | b\nc', suggestion: 'x|y' })]),
      'markdown',
      opts,
    );
    expect(out).toContain('| a \\| b<br>c<br>Suggestion: `x\\|y` |');
  });

  it('neutralises mentions and HTML outside code and fences suggestions', () => {
    const out = formatReport(
      report([
        fail({
          message: 'See @org/team <!-- x --> and `@keep <b>`',
          suggestion: '@types/node@22',
        }),
        fail({ line: 5, message: 'm', suggestion: 'a`b|c' }),
      ]),
      'markdown',
      opts,
    );
    expect(out).toContain(
      '| See @‍org/team &lt;!-- x --> and `@keep <b>`<br>Suggestion: `@types/node@22` |',
    );
    expect(out).toContain('Suggestion: ``a`b\\|c`` |');
    expect(out.split('<!-- ctxtruth-report -->')).toHaveLength(2);
  });

  it('separates code-introduced findings and hides existing ones', () => {
    expect(formatReport(compared(), 'markdown', opts)).toBe(
      [
        '<!-- ctxtruth-report -->',
        '### ctxtruth',
        '',
        'This pull request makes **2** documentation claims false (1 by changing code, 1 in the docs). 1 existing problem was fixed.',
        '',
        '<sub>1 existing problem not shown; 1 not comparable with the base.</sub>',
        '',
        '#### Made false by code changes',
        '',
        '**AGENTS.md**',
        '',
        '| Location | Severity | Check | Problem |',
        '| --- | --- | --- | --- |',
        '| `AGENTS.md:2` | 🔴 error | paths | Code problem |',
        '',
        '#### Introduced in docs',
        '',
        '**AGENTS.md**',
        '',
        '| Location | Severity | Check | Problem |',
        '| --- | --- | --- | --- |',
        '| `AGENTS.md:4` | 🔴 error | paths | Docs problem |',
        '',
        '<details><summary>Freshness per file</summary>',
        '',
        '- `AGENTS.md`: 20% (1/5)',
        '',
        '</details>',
        '',
        '<sub>ctxtruth 1.2.3</sub>',
        '',
      ].join('\n'),
    );
  });

  it('caps the listed findings', () => {
    const many = Array.from({ length: 120 }, (_, i) => fail({ line: i + 1 }));
    const out = formatReport(report(many), 'markdown', opts);
    expect(out.match(/^\| `AGENTS\.md:/gm)).toHaveLength(50);
    expect(out).toContain('…and 70 more');
    expect(out.length).toBeLessThan(65_536);
  });

  it('formats the drift fixture', async () => {
    const { report: r } = await check({ root: resolve('test/fixtures/drift') });
    const out = formatReport(r, 'markdown', opts);
    expect(out.startsWith('<!-- ctxtruth-report -->\n### ctxtruth\n')).toBe(true);
    expect(out).toContain('**11** documentation claims are false (6 errors, 5 warnings).');
    expect(out).toContain('**docs/guide.md**');
  });
});
