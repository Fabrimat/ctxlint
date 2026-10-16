export type Status = 'consistent' | 'drift' | 'unknown';

/** One judged (case, repeat) pair. */
export interface JudgedRecord {
  caseId: string;
  repeat: number;
  label: 'drift' | 'consistent';
  adversarial: boolean;
  status: Status;
  /** The provider rejected the output as invalid. */
  invalid: boolean;
  costUsd: number;
  latencyMs: number;
}

export interface Metrics {
  n: number;
  precision: number | null;
  recall: number | null;
  unsureRate: number | null;
  invalidRate: number | null;
  /** Drift verdicts on adversarial cases whose label is consistent. */
  advFpr: number | null;
  flipRate: number | null;
  meanCostUsd: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

/** Nearest-rank percentile of an unsorted list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}

/** `unknown` counts as not-drift for precision and as a miss for recall. */
export function computeMetrics(records: readonly JudgedRecord[]): Metrics {
  const n = records.length;
  const predicted = records.filter((r) => r.status === 'drift');
  const tp = predicted.filter((r) => r.label === 'drift').length;
  const actual = records.filter((r) => r.label === 'drift').length;
  const advNeg = records.filter((r) => r.adversarial && r.label === 'consistent');
  const byCase = new Map<string, Status[]>();
  for (const r of records) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r.status]);
  const repeated = [...byCase.values()].filter((s) => s.length > 1);
  return {
    n,
    precision: ratio(tp, predicted.length),
    recall: ratio(tp, actual),
    unsureRate: ratio(records.filter((r) => r.status === 'unknown').length, n),
    invalidRate: ratio(records.filter((r) => r.invalid).length, n),
    advFpr: ratio(advNeg.filter((r) => r.status === 'drift').length, advNeg.length),
    flipRate: ratio(repeated.filter((s) => new Set(s).size > 1).length, repeated.length),
    meanCostUsd: ratio(
      records.reduce((sum, r) => sum + r.costUsd, 0),
      n,
    ),
    p50Ms: percentile(
      records.map((r) => r.latencyMs),
      50,
    ),
    p95Ms: percentile(
      records.map((r) => r.latencyMs),
      95,
    ),
  };
}

const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

export function markdownTable(rows: { model: string; metrics: Metrics }[]): string {
  const head =
    '| model | precision | recall | unsure | invalid | FPR (adv) | flip | $/check | p50 | p95 | n |';
  const lines = rows.map(({ model, metrics: m }) =>
    [
      model,
      pct(m.precision),
      pct(m.recall),
      pct(m.unsureRate),
      pct(m.invalidRate),
      pct(m.advFpr),
      pct(m.flipRate),
      m.meanCostUsd === null ? 'n/a' : `$${m.meanCostUsd.toFixed(5)}`,
      m.p50Ms === null ? 'n/a' : `${Math.round(m.p50Ms)} ms`,
      m.p95Ms === null ? 'n/a' : `${Math.round(m.p95Ms)} ms`,
      String(m.n),
    ].join(' | '),
  );
  return [head, `|${' --- |'.repeat(11)}`, ...lines.map((l) => `| ${l} |`)].join('\n');
}
