import type { Report } from '../types.js';
import { formatJson } from './json.js';
import { formatText } from './text.js';

export { buildReport } from './build.js';
export { formatText } from './text.js';
export { formatJson } from './json.js';

export type Format = 'text' | 'json';

export function formatReport(
  report: Report,
  format: Format,
  opts: { color: boolean; verbose: boolean },
): string {
  return format === 'json' ? formatJson(report) : formatText(report, opts);
}
