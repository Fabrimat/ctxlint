import type { Finding, Report } from '../types.js';
import { driftText, fixText, modelsOf } from './agent.js';
import { isSemantic, reportedResults, skippedLine, verified } from './build.js';
import { llmLine } from './llm.js';
import type { FormatOptions } from './index.js';

/** The action finds and updates its pull request comment by this marker. */
const MARKER = '<!-- ctxtruth-report -->';
/** Keeps the comment well under the GitHub comment limit of 65 536 characters. */
const MAX_LISTED = 50;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const percent = (f: number | null): string => (f === null ? 'n/a' : `${Math.round(f * 100)}%`);

const pipes = (s: string): string => s.replace(/\|/g, '\\|');

/** Inline code span; the fence is longer than any backtick run inside. */
function code(s: string): string {
  const flat = s.replace(/\r?\n/g, ' ');
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/**
 * Make text safe inside a table cell: outside code spans, neutralise @mentions and escape `<` so
 * diagnostic text cannot inject HTML (or the report marker); everywhere, escape pipes and newlines.
 */
const cell = (s: string): string =>
  s
    .split(/(`+[^`]+`+)/)
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(/</g, '&lt;').replace(/@(?=[\w-])/g, '@\u200d'),
    )
    .join('')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');

function summary(report: Report, findings: Finding[]): string {
  const c = report.comparison;
  if (findings.length === 0) {
    return c ? '✅ No documentation drift introduced.' : '✅ No documentation drift found.';
  }
  const n = findings.length;
  if (!c) {
    const { errors, warnings } = report.summary;
    return `**${n}** documentation ${n === 1 ? 'claim is' : 'claims are'} false (${plural(errors, 'error')}, ${plural(warnings, 'warning')}).`;
  }
  const code = findings.filter((f) => f.introducedBy === 'code').length;
  const parts = [
    code > 0 ? `${code} by changing code` : null,
    n - code > 0 ? `${n - code} in the docs` : null,
  ].filter((x) => x !== null);
  const fixed =
    c.fixed > 0
      ? ` ${plural(c.fixed, 'existing problem')} ${c.fixed === 1 ? 'was' : 'were'} fixed.`
      : '';
  return `This pull request makes **${n}** documentation ${n === 1 ? 'claim' : 'claims'} false (${parts.join(', ')}).${fixed}`;
}

function mutedLine(report: Report): string | null {
  const c = report.comparison;
  if (!c) return null;
  const parts = [
    c.existing > 0 ? `${plural(c.existing, 'existing problem')} not shown` : null,
    c.notComparable > 0 ? `${c.notComparable} not comparable with the base` : null,
  ].filter((x) => x !== null);
  return parts.length > 0 ? `<sub>${parts.join('; ')}.</sub>` : null;
}

/** One table per file. */
function tables(findings: Finding[], opts: FormatOptions): string[] {
  const out: string[] = [];
  for (const file of new Set(findings.map((f) => f.file))) {
    out.push(
      `**${file}**`,
      '',
      '| Location | Severity | Check | Problem |',
      '| --- | --- | --- | --- |',
    );
    for (const f of findings.filter((x) => x.file === file)) {
      const pos = `${f.file}:${f.line}`;
      const loc = opts.linkBase
        ? `[\`${pos}\`](${opts.linkBase}/${f.file}#L${f.line})`
        : `\`${pos}\``;
      const sev = f.severity === 'error' ? '🔴 error' : '🟡 warning';
      const sug = f.suggestion === undefined ? '' : `<br>Suggestion: ${pipes(code(f.suggestion))}`;
      out.push(`| ${loc} | ${sev} | ${f.checkId} | ${cell(f.message)}${sug} |`);
    }
    out.push('');
  }
  return out;
}

/** Model-judged findings, apart from the verified ones. */
function semanticTable(findings: Finding[], opts: FormatOptions): string[] {
  const listed = findings.slice(0, MAX_LISTED);
  const out = [
    '#### Possible semantic drift (model-judged)',
    '',
    `<sub>Judged by ${cell(modelsOf(findings))}, not verified: confirm against the code before editing.</sub>`,
    '',
    '| Location | Severity | Possible drift |',
    '| --- | --- | --- |',
  ];
  for (const f of listed) {
    const pos = `${f.file}:${f.line}`;
    const loc = opts.linkBase
      ? `[\`${pos}\`](${opts.linkBase}/${f.file}#L${f.line})`
      : `\`${pos}\``;
    const sev = f.severity === 'error' ? '🔴 error' : '🟡 warning';
    // Model text only inside code spans: no live links, images, HTML or mentions.
    const fix = f.proposedFix
      ? `<br>Proposed (unverified): ${pipes(code(fixText(f.proposedFix)))}`
      : '';
    out.push(`| ${loc} | ${sev} | ${pipes(code(driftText(f)))}${fix} |`);
  }
  out.push('');
  if (findings.length > listed.length) out.push(`…and ${findings.length - listed.length} more`, '');
  return out;
}

/** The pull request comment body. */

export function formatMarkdown(report: Report, opts: FormatOptions): string {
  const reported = reportedResults(report);
  const all = reported.filter((r) => !isSemantic(r)).flatMap((r) => (r.finding ? [r.finding] : []));
  const semantic = reported.filter(isSemantic).flatMap((r) => (r.finding ? [r.finding] : []));
  const compared = report.comparison !== undefined;
  const code = compared ? all.filter((f) => f.introducedBy === 'code') : [];
  const rest = compared ? all.filter((f) => f.introducedBy !== 'code') : all;
  const listed = [...code, ...rest].slice(0, MAX_LISTED);
  const listedCode = listed.slice(0, code.length);
  const listedRest = listed.slice(code.length);

  const out = [MARKER, '### ctxtruth', '', summary(report, all), ''];
  const muted = mutedLine(report);
  if (muted) out.push(muted, '');
  if (report.llm) out.push(`<sub>${llmLine(report.llm)}</sub>`, '');
  for (const s of report.skipped ?? []) out.push(`<sub>${cell(skippedLine(s))}</sub>`, '');

  if (listedCode.length > 0) {
    out.push('#### Made false by code changes', '', ...tables(listedCode, opts));
  }
  if (listedRest.length > 0) {
    if (compared) out.push('#### Introduced in docs', '');
    out.push(...tables(listedRest, opts));
  }
  if (all.length > listed.length) out.push(`…and ${all.length - listed.length} more`, '');
  if (semantic.length > 0) out.push(...semanticTable(semantic, opts));

  out.push('<details><summary>Freshness per file</summary>', '');
  for (const f of report.files) {
    const { pass, fail } = verified(f.results);
    out.push(`- \`${f.file}\`: ${percent(f.freshness)} (${pass}/${pass + fail})`);
  }
  out.push('', '</details>', '', `<sub>ctxtruth ${report.tool.version}</sub>`);
  return `${out.join('\n')}\n`;
}
