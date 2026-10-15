import type { Report } from '../types.js';
import { formatAgent } from './agent.js';
import { formatJson } from './json.js';
import { formatMarkdown } from './markdown.js';
import { formatSarif } from './sarif.js';
import { formatText } from './text.js';

export { buildReport, isReported, reportedResults } from './build.js';
export { formatText } from './text.js';
export { formatJson } from './json.js';

export const FORMATS = ['text', 'json', 'sarif', 'markdown', 'agent'] as const;
export type Format = (typeof FORMATS)[number];

export interface FormatOptions {
  color: boolean;
  verbose: boolean;
  /**
   * URL prefix for links to repository files, e.g. `https://github.com/o/r/blob/<sha>`.
   * Used by the markdown output; files are plain text without it.
   */
  linkBase?: string;
  /** SARIF rule descriptions of plugin checks, by check id. */
  descriptions?: Record<string, string>;
}

export function formatReport(report: Report, format: Format, opts: FormatOptions): string {
  switch (format) {
    case 'json':
      return formatJson(report);
    case 'sarif':
      return formatSarif(report, opts);
    case 'markdown':
      return formatMarkdown(report, opts);
    case 'agent':
      return formatAgent(report, opts);
    case 'text':
      return formatText(report, opts);
  }
}
