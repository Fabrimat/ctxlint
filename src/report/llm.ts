import type { LlmTotals } from '../types.js';

const tokens = (n: number): string => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);

/** `llm: 12 calls · 48.2k in / 2.1k out · $0.0700 · 14.2 s · budget $1.00 (3 skipped)` */
export function llmLine(t: LlmTotals): string {
  const cost =
    t.costUsd === null ? 'cost unknown' : `${t.costEstimated ? '~' : ''}$${t.costUsd.toFixed(4)}`;
  const budget = t.budgetUsd === null ? 'no budget' : `budget $${t.budgetUsd.toFixed(2)}`;
  const skipped = t.skipped > 0 ? ` (${t.skipped} skipped)` : '';
  return [
    `llm: ${t.calls} ${t.calls === 1 ? 'call' : 'calls'}`,
    `${tokens(t.inputTokens)} in / ${tokens(t.outputTokens)} out`,
    cost,
    `${(t.latencyMs / 1000).toFixed(1)} s`,
    `${budget}${skipped}`,
  ].join(' · ');
}
