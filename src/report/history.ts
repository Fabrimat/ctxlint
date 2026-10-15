import type { HistoryResult } from '../history.js';

export const HISTORY_FORMATS = ['text', 'jsonl', 'json'] as const;
export type HistoryFormat = (typeof HISTORY_FORMATS)[number];

const pct = (n: number, total: number): string =>
  total === 0 ? '0%' : `${Math.round((n / total) * 100)}%`;

function formatHistoryText({ repo, commits, summary: s }: HistoryResult): string {
  const lines = [
    `${repo}: ${commits} commits walked, ${s.episodes} stale episodes`,
    `  open now: ${s.open} (${s.openPct}%)`,
    `  opened by: code ${s.causes.code} (${pct(s.causes.code, s.episodes)}), docs ${s.causes.docs} (${pct(s.causes.docs, s.episodes)}), already stale at start ${s.causes.unknown}`,
    `  median days open (closed episodes): ${s.medianDaysClosed ?? 'n/a'}`,
  ];
  if (s.topFiles.length > 0) {
    lines.push('  top files:', ...s.topFiles.map((f) => `    ${f.file}  ${f.episodes}`));
  }
  return `${lines.join('\n')}\n`;
}

export function formatHistory(result: HistoryResult, format: HistoryFormat): string {
  switch (format) {
    case 'jsonl':
      return result.episodes.map((e) => `${JSON.stringify(e)}\n`).join('');
    case 'json': {
      const { repo, commits, episodes, summary } = result;
      return `${JSON.stringify({ version: 1, repo, commits, episodes, summary }, null, 2)}\n`;
    }
    case 'text':
      return formatHistoryText(result);
  }
}
