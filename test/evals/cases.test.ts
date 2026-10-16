import { describe, expect, it } from 'vitest';
import { loadCases, matchesGlob } from '../../evals/cases.ts';

describe('semantic eval cases', () => {
  const cases = loadCases();

  it('has at least 24 cases, all parsed, with unique ids', () => {
    expect(cases.length).toBeGreaterThanOrEqual(24);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('is balanced between drift and consistent', () => {
    const share = cases.filter((c) => c.label === 'drift').length / cases.length;
    expect(share).toBeGreaterThanOrEqual(0.4);
    expect(share).toBeLessThanOrEqual(0.6);
  });

  it('has a meaningful adversarial subset and realistic snippets', () => {
    expect(
      cases.filter((c) => c.adversarial && c.label === 'consistent').length,
    ).toBeGreaterThanOrEqual(8);
    expect(cases.filter((c) => c.adversarial && c.label === 'drift').length).toBe(1);
    for (const c of cases) {
      const lines = c.files.reduce((n, f) => n + f.content.split('\n').length, 0);
      expect(lines, c.id).toBeGreaterThanOrEqual(20);
      expect(
        c.files.some((f) => f.changed),
        c.id,
      ).toBe(true);
    }
  });

  it('filters by id glob', () => {
    expect(matchesGlob('retries-count', 'retries-*')).toBe(true);
    expect(matchesGlob('retries-count', 'retries')).toBe(false);
    expect(loadCases(undefined, 'retries-*').map((c) => c.id)).toEqual([
      'retries-count',
      'retries-match',
    ]);
  });
});
