import type { CheckResult, Finding, Report } from '../types.js';
import { isSemantic, reportedResults } from './build.js';
import { llmLine } from './llm.js';
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

/** The quote and explanation of a semantic finding: its message without the prefix. */
export const driftText = (f: Finding): string => f.message.replace(/^Possible drift: /, '');

/** A proposed fix on one line, newlines shown as ⏎. */
export const fixText = (fix: NonNullable<Finding['proposedFix']>): string =>
  `replace lines ${fix.startLine}-${fix.endLine} with: ${fix.replacement.replace(/\r?\n/g, '⏎')}`;

/** Model ids of `findings`, for the semantic headers. */
export const modelsOf = (findings: readonly Finding[]): string =>
  [...new Set(findings.flatMap((f) => (f.model === undefined ? [] : [f.model])))].join(', ') ||
  'a model';

function semanticLines(findings: Finding[]): string[] {
  const out = [
    `${plural(findings.length, 'possible semantic drift')}, judged by ${modelsOf(findings)}, not verified; read the code before editing.`,
  ];
  for (const f of findings) {
    out.push(`${f.file}:${f.line} [${f.severity} semantic] ${driftText(f)}`);
    if (f.proposedFix) {
      out.push(`  → proposed (${f.model ?? 'model'}, unverified): ${fixText(f.proposedFix)}`);
    }
  }
  return out;
}

function unknownLine(r: CheckResult): string {
  const { file, line, kind, value } = r.claim;
  return `${file}:${line} [unknown ${kind}] ${value}: ${r.reason ?? 'could not be verified'}`;
}

/** Terse output for coding agents that run the CLI themselves. */
export function formatAgent(report: Report, opts: FormatOptions): string {
  const reported = reportedResults(report);
  const results = reported.filter((r) => !isSemantic(r));
  const findings = results.flatMap((r) => (r.finding ? [r.finding] : []));
  const semantic = reported.filter(isSemantic).flatMap((r) => (r.finding ? [r.finding] : []));
  const out: string[] = [];

  if (findings.length === 0) {
    const verified = `ctxtruth: no stale claims (${plural(report.summary.pass, 'claim')} verified).`;
    out.push(
      semantic.length === 0
        ? `${verified} The docs checked are consistent with the code.`
        : verified,
    );
  } else {
    const files = new Set(findings.map((f) => f.file)).size;
    out.push(
      `ctxtruth: ${plural(findings.length, 'stale claim')} in ${plural(files, 'file')}. These facts were verified against the repository; trust them over the docs.`,
    );
    out.push(...results.map((r) => findingLine(r, report.comparison !== undefined)));
  }
  if (semantic.length > 0) out.push(...semanticLines(semantic));

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
  if (semantic.length > 0) {
    out.push('For the possible semantic drifts: confirm against the code, then fix.');
  }
  if (report.llm) out.push(llmLine(report.llm));
  return `${out.join('\n')}\n`;
}
