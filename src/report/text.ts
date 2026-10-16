import { styleText } from 'node:util';
import type { FileReport, Finding, Report } from '../types.js';
import { driftText, fixText } from './agent.js';
import { isReported, isSemantic, skippedLine, verified } from './build.js';
import { llmLine } from './llm.js';

type Style = Parameters<typeof styleText>[0];

interface Row {
  line: number;
  col: number;
  sev: string;
  sevStyle: Style;
  msg: string;
  /** Check id shown in the right-hand column; empty for unknown rows. */
  id: string;
  suggestion?: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const percent = (f: number | null): string => (f === null ? 'n/a' : `${Math.round(f * 100)}%`);

function findingRow(f: Finding): Row {
  const row: Row = {
    line: f.line,
    col: f.col,
    sev: f.severity,
    sevStyle: f.severity === 'error' ? 'red' : 'yellow',
    msg: f.message,
    id: f.checkId,
  };
  if (f.suggestion !== undefined) row.suggestion = f.suggestion;
  return row;
}

function fileRows(file: FileReport, verbose: boolean): Row[] {
  const rows: Row[] = [];
  for (const r of file.results) {
    if (isSemantic(r)) continue;
    const { line, col, kind, value } = r.claim;
    if (isReported(r) && r.finding) {
      rows.push(findingRow(r.finding));
    } else if (r.status === 'unknown' && verbose) {
      const reason = r.reason ?? 'could not be verified';
      rows.push({
        line,
        col,
        sev: 'unknown',
        sevStyle: 'dim',
        msg: `${kind} \`${value}\` — ${reason}`,
        id: '',
      });
    }
  }
  return rows.sort((a, b) => a.line - b.line || a.col - b.col);
}

function formatFile(
  file: FileReport,
  rows: Row[],
  paint: (s: string, style: Style) => string,
): string[] {
  const { pass, fail } = verified(file.results);
  const out = [
    `${paint(file.file, 'bold')}  freshness ${percent(file.freshness)} (${pass}/${pass + fail})`,
  ];

  const pos = rows.map((r) => `${r.line}:${r.col}`);
  const posW = Math.max(...pos.map((p) => p.length));
  const sevW = Math.max(...rows.map((r) => r.sev.length));
  const msgW = Math.max(...rows.map((r) => r.msg.length));
  const indent = ' '.repeat(2 + posW + 2 + sevW + 2);

  rows.forEach((r, i) => {
    const head = `  ${paint((pos[i] ?? '').padEnd(posW), 'dim')}  ${paint(r.sev.padEnd(sevW), r.sevStyle)}  `;
    out.push(head + (r.id === '' ? r.msg : `${r.msg.padEnd(msgW)}  ${paint(r.id, 'dim')}`));
    if (r.suggestion !== undefined) out.push(`${indent}suggestion: ${r.suggestion}`);
  });
  out.push('');
  return out;
}

function formatSummary(s: Report['summary'], paint: (s: string, style: Style) => string): string {
  const stats = [
    plural(s.claims, 'claim'),
    `${s.pass} verified`,
    `${s.unknown} unknown`,
    `freshness ${percent(s.freshness)}`,
    `${s.durationMs} ms`,
  ].join(' · ');

  if (s.errors + s.warnings === 0) return `${paint('✔', 'green')} No drift found · ${stats}`;

  const counts = [
    s.errors > 0 ? plural(s.errors, 'error') : null,
    s.warnings > 0 ? plural(s.warnings, 'warning') : null,
  ]
    .filter((x) => x !== null)
    .join(', ');
  return `${paint('✖', s.errors > 0 ? 'red' : 'yellow')} ${counts} · ${stats}`;
}

export function formatText(report: Report, opts: { color: boolean; verbose: boolean }): string {
  const paint = (s: string, style: Style): string =>
    opts.color ? styleText(style, s, { validateStream: false }) : s;

  const out: string[] = [];
  for (const file of report.files) {
    const rows = fileRows(file, opts.verbose);
    if (rows.length > 0) out.push(...formatFile(file, rows, paint));
  }
  const semantic = report.files
    .flatMap((f) => f.results)
    .filter((r) => isSemantic(r) && isReported(r))
    .flatMap((r) => (r.finding ? [r.finding] : []));
  if (semantic.length > 0) {
    out.push(paint('Possible semantic drift (model-judged)', 'bold'));
    for (const f of semantic) {
      const sev = paint(f.severity, f.severity === 'error' ? 'red' : 'yellow');
      out.push(`  ${paint(`${f.file}:${f.line}`, 'dim')}  ${sev}  ${driftText(f)}`);
      if (f.proposedFix) {
        out.push(`    proposed (${f.model ?? 'model'}, unverified): ${fixText(f.proposedFix)}`);
      }
    }
    out.push('');
  }
  out.push(formatSummary(report.summary, paint));

  for (const s of report.skipped ?? []) out.push(paint(skippedLine(s), 'dim'));
  if (report.llm) out.push(llmLine(report.llm));
  return `${out.join('\n')}\n`;
}
