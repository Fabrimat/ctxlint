import { describe, expect, it } from 'vitest';
import { changedOnly, classify, renamed } from '../src/compare.js';
import type { CheckResult } from '../src/types.js';
import { fail, pass, unknown } from './report/make.js';

const diff = (changed: string[] = [], renames: [string, string][] = []) => ({
  changed: new Set(changed),
  renames: new Map(renames),
});

/** A pass for the same claim as `fail({ value })`. */
const passing = (value = 'src/gone.ts', line = 2): CheckResult => {
  const r = fail({ value, line });
  delete r.finding;
  return { ...r, status: 'pass' };
};

describe('classify', () => {
  it('matches failures by count in document order', () => {
    const head = [fail({ line: 9 }), fail({ line: 3 }), fail({ line: 6 })];
    const counts = classify(head, [fail(), fail()], diff());
    expect(head.map((r) => [r.claim.line, r.baseline])).toEqual([
      [9, 'new'],
      [3, 'existing'],
      [6, 'existing'],
    ]);
    expect(head[0]?.finding?.introducedBy).toBe('docs');
    expect(counts).toEqual({ introduced: 1, existing: 2, fixed: 0, notComparable: 0 });
  });

  it('attributes a claim that passed at the base to code only when the doc is unchanged', () => {
    const head = [fail()];
    expect(classify(head, [passing()], diff()).introduced).toBe(1);
    expect(head[0]?.finding?.introducedBy).toBe('code');
    const edited = [fail()];
    classify(edited, [passing()], diff(['AGENTS.md']));
    expect(edited[0]?.finding?.introducedBy).toBe('docs');
  });

  it('marks failures that were unknown at the base as not comparable', () => {
    const u = unknown();
    const head = [fail({ value: u.claim.value, line: 9 })];
    expect(classify(head, [u], diff())).toEqual({
      introduced: 0,
      existing: 0,
      fixed: 0,
      notComparable: 1,
    });
    expect(head[0]?.baseline).toBe('not-comparable');
    expect(head[0]?.finding?.introducedBy).toBeUndefined();
  });

  it('ignores the section, so a renamed heading keeps claims existing', () => {
    const base = fail();
    base.claim.section = ['Old heading'];
    const head = [fail()];
    classify(head, [base], diff());
    expect(head[0]?.baseline).toBe('existing');
  });

  it('ignores line endings converted by the checkout', () => {
    const head = [fail({ value: 'a\nb' })];
    classify(head, [fail({ value: 'a\r\nb' })], diff());
    expect(head[0]?.baseline).toBe('existing');
  });

  it('counts fixed only for claims still present and passing', () => {
    const counts = classify(
      [passing(), passing('src/other.ts')],
      [fail(), fail(), fail({ value: 'src/removed.ts' })],
      diff(),
    );
    expect(counts.fixed).toBe(1);
  });

  it('does not count commands or versions as fixed (the base has no node_modules)', () => {
    const asCommand = (r: CheckResult): CheckResult => ({ ...r, checkId: 'commands' });
    const counts = classify([asCommand(passing())], [asCommand(fail())], diff());
    expect(counts.fixed).toBe(0);
  });

  it('maps renamed docs before matching', () => {
    const base = renamed(fail({ file: 'OLD.md' }), new Map([['OLD.md', 'AGENTS.md']]));
    const head = [fail()];
    classify(head, [base], diff(['OLD.md', 'AGENTS.md'], [['OLD.md', 'AGENTS.md']]));
    expect(head[0]?.baseline).toBe('existing');
  });
});

describe('changedOnly', () => {
  const at = (value: string, files: string[], status: 'pass' | 'fail' = 'pass') => {
    const r = status === 'pass' ? passing(value) : fail({ value });
    r.resolvedFiles = files;
    return r;
  };

  it('keeps claims in changed docs or about changed files', () => {
    const kept = changedOnly(
      [at('a', ['src/a.ts']), at('b', ['src/b.ts']), pass('docs/x.md')],
      [],
      diff(['src/a.ts', 'docs/x.md']),
    );
    expect(kept.map((r) => r.claim.value)).toEqual(['a', 'ok']);
  });

  it('uses the base resolved files of the same claim', () => {
    const head = [at('gone', [], 'fail')];
    expect(changedOnly(head, [], diff(['src/gone.ts']))).toEqual([]);
    expect(changedOnly(head, [at('gone', ['src/gone.ts'])], diff(['src/gone.ts']))).toEqual(head);
  });
});
