import type { BlameChange, BlameFinding, BlameReport } from '../blame.js';

export type BlameFormat = 'text' | 'json' | 'agent';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const short = (sha: string): string => sha.slice(0, 7);
const day = (iso: string): string => iso.slice(0, 10);
const loc = (b: BlameFinding): string => `${b.finding.file}:${b.finding.line}:${b.finding.col}`;

function change(c: BlameChange): string {
  return c.status === 'renamed'
    ? `\`${c.from}\` was renamed to \`${c.to}\``
    : `\`${c.from}\` was deleted`;
}

/** `3f2a1bc (2026-03-04, "subject")`. */
function commitRef(b: BlameFinding): string {
  const c = b.commit;
  return c ? `${short(c.sha)} (${day(c.date)}, "${c.subject}")` : '';
}

const UNDETERMINED =
  'could not be traced through history (the check cannot verify it at past commits)';
const UNCONFIRMED = ' (earlier commits not verifiable)';

/** `broken-by` asserts the previous commit passed; without that proof the claim only first fails there. */
const verb = (b: BlameFinding): string =>
  b.confirmedBefore === false ? 'first fails at' : 'broken by';

function agentLine(b: BlameFinding): string {
  const flat = b.value.replace(/\s+/g, ' ');
  const shown = flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
  const head = `${loc(b)} [${b.finding.checkId}] \`${shown}\``;
  if (b.cause === 'undetermined') return `${head} ${UNDETERMINED}`;
  if (b.cause === 'uncommitted') return `${head} broken by uncommitted changes`;
  if (b.cause === 'stale-when-written') {
    return b.commit
      ? `${head} wrong since written in ${commitRef(b)}`
      : `${head} wrong in a line that is not committed yet`;
  }
  const hint = b.changes?.map((c) =>
    c.status === 'renamed' ? `renamed to \`${c.to}\` there` : 'deleted there',
  );
  return `${head} ${verb(b)} ${commitRef(b)}${hint && hint.length > 0 ? ` — ${hint.join(', ')}` : ''}${b.confirmedBefore === false ? UNCONFIRMED : ''}`;
}

function formatAgent(report: BlameReport): string {
  const n = report.findings.length;
  if (n === 0) return 'ctxtruth blame: no stale claims.\n';
  const head = `ctxtruth blame: ${plural(n, 'stale claim')}. Each line names the commit that made the claim false; inspect it with \`git show <sha>\`.`;
  return `${[head, ...report.findings.map(agentLine)].join('\n')}\n`;
}

function textLines(b: BlameFinding): string[] {
  const where = `${b.finding.line}:${b.finding.col}`;
  const who = (c: NonNullable<BlameFinding['commit']>): string =>
    `${short(c.sha)}  ${day(c.date)}  ${c.author}  ${c.subject}`;
  const ago = b.commitsAgo === undefined ? '' : ` (${plural(b.commitsAgo, 'commit')} ago)`;
  const lines = [`  ${where}  [${b.finding.checkId}] ${b.finding.message}`];
  if (b.cause === 'broken-by' && b.commit) {
    lines.push(
      `      ${verb(b)} ${who(b.commit)}${ago}${b.confirmedBefore === false ? UNCONFIRMED : ''}`,
    );
  } else if (b.cause === 'undetermined') lines.push(`      ${UNDETERMINED}`);
  else if (b.cause === 'stale-when-written' && b.commit) {
    lines.push(`      wrong since written in ${who(b.commit)}${ago}`);
  } else if (b.cause === 'stale-when-written') {
    lines.push('      wrong in a line that is not committed yet');
  } else lines.push('      broken by uncommitted changes');
  if (b.cause === 'broken-by' && b.written) {
    lines.push(`      doc line written in ${who(b.written)}`);
  }
  for (const c of b.changes ?? []) lines.push(`      ${change(c)} in that commit`);
  return lines;
}

function formatText(report: BlameReport): string {
  const n = report.findings.length;
  if (n === 0) return 'No stale claims.\n';
  const out: string[] = [];
  let file: string | undefined;
  for (const b of report.findings) {
    if (b.finding.file !== file) {
      if (file !== undefined) out.push('');
      file = b.finding.file;
      out.push(file);
    }
    out.push(...textLines(b));
  }
  out.push(
    '',
    `${plural(n, 'stale claim')} · ${plural(report.probes, 'commit')} inspected · ${report.durationMs} ms`,
  );
  return `${out.join('\n')}\n`;
}

export function formatBlame(report: BlameReport, format: BlameFormat): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  return format === 'agent' ? formatAgent(report) : formatText(report);
}
