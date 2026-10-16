import type { CheckResult, FileReport, Finding, Report } from '../types.js';

const ratio = (pass: number, fail: number): number | null =>
  pass + fail === 0 ? null : pass / (pass + fail);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const countStatus = (rs: CheckResult[], s: CheckResult['status']): number =>
  rs.filter((r) => r.status === s).length;

/** Model-judged results (`--llm`): reported as findings, but never part of freshness. */
export const isSemantic = (r: { checkId: string }): boolean => r.checkId === 'semantic';

/** Pass and fail counts of the deterministic (verified) results. */
export function verified(rs: CheckResult[]): { pass: number; fail: number } {
  const det = rs.filter((r) => !isSemantic(r));
  return { pass: countStatus(det, 'pass'), fail: countStatus(det, 'fail') };
}

/** True for failing results that are reported: all of them, or only new ones after a comparison. */
export const isReported = (r: CheckResult): boolean =>
  r.status === 'fail' && r.finding !== undefined && (r.baseline ?? 'new') === 'new';

/** Reported failing results in finding order (file, line, col, check). */
export function reportedResults(report: Report): CheckResult[] {
  const order = new Map(report.findings.map((f, i) => [f, i]));
  return report.files
    .flatMap((f) => f.results)
    .filter(isReported)
    .sort(
      (a, b) => (order.get(a.finding as Finding) ?? 0) - (order.get(b.finding as Finding) ?? 0),
    );
}

export function buildReport(
  results: CheckResult[],
  docFiles: string[],
  meta: { toolVersion: string; durationMs: number },
): Report {
  const byFile = new Map<string, CheckResult[]>(docFiles.map((f) => [f, []]));
  for (const r of results) {
    const list = byFile.get(r.claim.file);
    if (list) list.push(r);
    else byFile.set(r.claim.file, [r]);
  }

  const files: FileReport[] = [...byFile.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([file, rs]) => {
      const { pass, fail } = verified(rs);
      return { file, freshness: ratio(pass, fail), results: rs };
    });

  const findings = results
    .flatMap((r) => (isReported(r) && r.finding ? [r.finding] : []))
    .sort(
      (a: Finding, b: Finding) =>
        cmp(a.file, b.file) || a.line - b.line || a.col - b.col || cmp(a.checkId, b.checkId),
    );

  const { pass, fail } = verified(results);

  return {
    version: 1,
    tool: { name: 'ctxtruth', version: meta.toolVersion },
    files,
    findings,
    summary: {
      files: files.length,
      claims: results.filter((r) => !isSemantic(r)).length,
      pass,
      fail,
      unknown: countStatus(
        results.filter((r) => !isSemantic(r)),
        'unknown',
      ),
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
      freshness: ratio(pass, fail),
      durationMs: meta.durationMs,
    },
  };
}
