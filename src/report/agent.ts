import type { CheckResult, Finding, Report } from '../types.js';
import { reportedResults } from './build.js';
import type { FormatOptions } from './index.js';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Phrase a suggestion as a directly actionable replacement for the check that produced it. */
function action(f: Finding, value: string): string {
  const s = f.suggestion;
  if (s === undefined) return '';
  const what = f.checkId === 'scripts' ? 'script ' : '';
  return ` → replace ${what}\`${value}\` with \`${s}\``;
}

function findingLine(r: CheckResult, compared: boolean): string {
  const f = r.finding as Finding;
  const tag = compared && f.introducedBy === 'code' ? '(code change) ' : '';
  return `${tag}${f.file}:${f.line}:${f.col} [${f.severity} ${f.checkId}] ${f.message}${action(f, r.claim.value)}`;
}

function unknownLine(r: CheckResult): string {
  const { file, line, kind, value } = r.claim;
  return `${file}:${line} [unknown ${kind}] ${value}: ${r.reason ?? 'could not be verified'}`;
}

/** Terse output for coding agents that run the CLI themselves. */
export function formatAgent(report: Report, opts: FormatOptions): string {
  const results = reportedResults(report);
  const findings = results.flatMap((r) => (r.finding ? [r.finding] : []));
  const out: string[] = [];

  if (findings.length === 0) {
    out.push(
      `ctxtruth: no stale claims (${plural(report.summary.pass, 'claim')} verified). The docs checked are consistent with the code.`,
    );
  } else {
    const files = new Set(findings.map((f) => f.file)).size;
    out.push(
      `ctxtruth: ${plural(findings.length, 'stale claim')} in ${plural(files, 'file')}. These facts were verified against the repository; trust them over the docs.`,
    );
    out.push(...results.map((r) => findingLine(r, report.comparison !== undefined)));
  }

  if (opts.verbose) {
    const unknown = report.files
      .flatMap((f) => f.results)
      .filter((r) => r.status === 'unknown')
      .sort(
        (a, b) =>
          cmp(a.claim.file, b.claim.file) ||
          a.claim.line - b.claim.line ||
          a.claim.col - b.claim.col,
      );
    out.push(...unknown.map(unknownLine));
  }

  if (findings.length > 0) {
    const how = findings.some((f) => f.suggestion !== undefined)
      ? 'using the → replacements'
      : 'so they match the repository';
    out.push(
      `To fix: edit the docs at the positions above ${how}; re-run \`ctxtruth check\` to confirm.`,
    );
  }
  return `${out.join('\n')}\n`;
}
