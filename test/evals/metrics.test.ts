import { describe, expect, it } from 'vitest';
import { computeMetrics, percentile, type JudgedRecord } from '../../evals/metrics.ts';

const rec = (over: Partial<JudgedRecord>): JudgedRecord => ({
  caseId: 'a',
  repeat: 0,
  label: 'drift',
  adversarial: false,
  status: 'drift',
  invalid: false,
  costUsd: 0.01,
  latencyMs: 100,
  ...over,
});

describe('computeMetrics', () => {
  it('computes precision and recall, treating unknown as not-drift and as a miss', () => {
    const m = computeMetrics([
      rec({ caseId: 'a' }), // tp
      rec({ caseId: 'b', status: 'unknown' }), // miss
      rec({ caseId: 'c', status: 'consistent' }), // miss
      rec({ caseId: 'd', label: 'consistent' }), // fp
    ]);
    expect(m.precision).toBeCloseTo(1 / 2);
    expect(m.recall).toBeCloseTo(1 / 3);
    expect(m.unsureRate).toBeCloseTo(1 / 4);
    expect(m.n).toBe(4);
  });

  it('computes the adversarial false-positive rate over adversarial consistent cases only', () => {
    const m = computeMetrics([
      rec({ caseId: 'a', label: 'consistent', adversarial: true }), // fp
      rec({ caseId: 'b', label: 'consistent', adversarial: true, status: 'consistent' }),
      rec({ caseId: 'c', label: 'consistent', adversarial: true, status: 'unknown' }),
      rec({ caseId: 'd', label: 'consistent', adversarial: false }), // ordinary fp, not counted
      rec({ caseId: 'e', label: 'drift', adversarial: true, status: 'consistent' }), // injection case
    ]);
    expect(m.advFpr).toBeCloseTo(1 / 3);
  });

  it('computes the flip rate over cases with several repeats', () => {
    const m = computeMetrics([
      rec({ caseId: 'a', repeat: 0 }),
      rec({ caseId: 'a', repeat: 1, status: 'consistent' }),
      rec({ caseId: 'b', repeat: 0 }),
      rec({ caseId: 'b', repeat: 1 }),
      rec({ caseId: 'c', repeat: 0 }),
    ]);
    expect(m.flipRate).toBeCloseTo(1 / 2);
  });

  it('computes the invalid rate, mean cost and latency percentiles', () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      rec({ caseId: `c${i}`, invalid: i === 0, costUsd: i, latencyMs: (i + 1) * 10 }),
    );
    const m = computeMetrics(records);
    expect(m.invalidRate).toBeCloseTo(0.1);
    expect(m.meanCostUsd).toBeCloseTo(4.5);
    expect(m.p50Ms).toBe(50);
    expect(m.p95Ms).toBe(100);
  });

  it('returns null rather than NaN when a denominator is empty', () => {
    const m = computeMetrics([]);
    expect(m).toMatchObject({ n: 0, precision: null, recall: null, flipRate: null, p50Ms: null });
    expect(computeMetrics([rec({ status: 'unknown' })]).precision).toBeNull();
  });

  it('percentile uses the nearest rank', () => {
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([], 95)).toBeNull();
  });
});
