import { describe, expect, it } from 'vitest';
import { formatReport, buildReport, type Format } from '../../src/report/index.js';
import { llmLine } from '../../src/report/llm.js';
import { reportSchema } from '../../src/schema/index.js';
import type { LlmTotals } from '../../src/types.js';

const totals: LlmTotals = {
  calls: 12,
  failedCalls: 1,
  skipped: 3,
  inputTokens: 48_200,
  outputTokens: 2_100,
  cacheReadTokens: 0,
  costUsd: 0.07,
  costEstimated: false,
  latencyMs: 14_200,
  budgetUsd: 1,
  models: ['claude-haiku-5-5'],
};
const LINE = 'llm: 12 calls · 48.2k in / 2.1k out · $0.0700 · 14.2 s · budget $1.00 (3 skipped)';
const opts = { color: false, verbose: false };
const report = (llm?: LlmTotals) => {
  const r = buildReport([], [], { toolVersion: '0.0.0', durationMs: 1 });
  if (llm) r.llm = llm;
  return r;
};

describe('llmLine', () => {
  it('prints calls, tokens, cost, time and budget', () => {
    expect(llmLine(totals)).toBe(LINE);
  });

  it('says when the cost is unknown or there is no budget, and omits zero skips', () => {
    expect(llmLine({ ...totals, calls: 1, costUsd: null, budgetUsd: null, skipped: 0 })).toBe(
      'llm: 1 call · 48.2k in / 2.1k out · cost unknown · 14.2 s · no budget',
    );
  });
});

describe('report.llm in every format', () => {
  it.each<Format>(['text', 'agent', 'markdown'])('%s carries the totals line', (format) => {
    expect(formatReport(report(totals), format, opts)).toContain(LINE);
    expect(formatReport(report(), format, opts)).not.toContain('llm:');
  });

  it('sarif puts the totals in runs[0].properties.llm', () => {
    const sarif = JSON.parse(formatReport(report(totals), 'sarif', opts)) as {
      runs: { properties?: { llm: LlmTotals } }[];
    };
    expect(sarif.runs[0]?.properties?.llm).toEqual(totals);
    const none = JSON.parse(formatReport(report(), 'sarif', opts)) as {
      runs: { properties?: unknown }[];
    };
    expect(none.runs[0]?.properties).toBeUndefined();
  });

  it('json is the object itself and satisfies the schema', () => {
    const json: unknown = JSON.parse(formatReport(report(totals), 'json', opts));
    expect(json).toMatchObject({ llm: totals });
    expect(reportSchema.safeParse(json).success).toBe(true);
    expect(reportSchema.safeParse(JSON.parse(formatReport(report(), 'json', opts))).success).toBe(
      true,
    );
  });

  it('the schema accepts the model and proposedFix of a finding', () => {
    const r = report();
    r.findings.push({
      file: 'a.md',
      line: 1,
      col: 1,
      checkId: 'semantic',
      severity: 'warning',
      message: 'm',
      model: 'claude-haiku-5-5',
      proposedFix: { startLine: 1, endLine: 2, replacement: 'x' },
    });
    expect(reportSchema.safeParse(JSON.parse(formatReport(r, 'json', opts))).success).toBe(true);
  });
});

describe('estimated cost', () => {
  it('is marked with a tilde', () => {
    expect(llmLine({ ...totals, costEstimated: true })).toContain('· ~$0.0700 ·');
  });
});
