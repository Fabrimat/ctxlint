import { createHash } from 'node:crypto';
import { fingerprint, type CheckId, type Report } from '../types.js';
import { reportedResults } from './build.js';
import type { FormatOptions } from './index.js';

const HELP_URI = 'https://github.com/Fabrimat/ctxtruth#what-it-checks';

const DESCRIPTIONS: Record<CheckId, string> = {
  paths: 'Documented file or directory does not exist',
  scripts: 'Documented package script does not exist',
  commands: 'Documented command cannot be resolved',
  symbols: 'Documented code symbol does not exist',
  snippets: 'Documented TypeScript snippet does not type-check',
  versions: 'Documented package version differs from the installed dependency',
};

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** SARIF 2.1.0 for GitHub code scanning: one result per reported finding. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function formatSarif(report: Report, _opts: FormatOptions): string {
  const results = reportedResults(report);
  const ids = [...new Set(results.map((r) => r.checkId))].sort();
  const level = (id: CheckId): string =>
    results.find((r) => r.checkId === id)?.finding?.severity ?? 'warning';

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'ctxtruth',
            version: report.tool.version,
            informationUri: 'https://github.com/Fabrimat/ctxtruth',
            rules: ids.map((id) => ({
              id,
              shortDescription: { text: DESCRIPTIONS[id] },
              helpUri: HELP_URI,
              defaultConfiguration: { level: level(id) },
            })),
          },
        },
        results: results.flatMap((r) => {
          const f = r.finding;
          if (!f) return [];
          const text =
            f.suggestion === undefined ? f.message : `${f.message} Suggestion: ${f.suggestion}`;
          return [
            {
              ruleId: f.checkId,
              level: f.severity,
              message: { text },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: f.file, uriBaseId: '%SRCROOT%' },
                    region: { startLine: f.line, startColumn: f.col },
                  },
                },
              ],
              partialFingerprints: { 'ctxtruthFingerprint/v1': sha256(fingerprint(r)) },
            },
          ];
        }),
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}
