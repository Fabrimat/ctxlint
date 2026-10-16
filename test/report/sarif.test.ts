import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../../src/run.js';
import { formatReport } from '../../src/report/index.js';
import { compared, fail, opts, pass, report } from './make.js';

interface Run {
  tool: { driver: { rules: { id: string }[] } };
  results: [{ message: { text: string }; partialFingerprints: Record<string, string> }];
}
const parse = (s: string): { runs: [Run] } => JSON.parse(s) as { runs: [Run] };

describe('sarif format', () => {
  it('emits a valid empty run', () => {
    const out = formatReport(report([pass()]), 'sarif', opts);
    expect(out.endsWith('}\n')).toBe(true);
    expect(parse(out)).toEqual({
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'ctxtruth',
              version: '1.2.3',
              informationUri: 'https://github.com/Fabrimat/ctxtruth',
              rules: [],
            },
          },
          results: [],
        },
      ],
    });
  });

  it('maps a finding to a result and rule', () => {
    const out = parse(formatReport(report([fail({ suggestion: 'src/new.ts' })]), 'sarif', opts));
    const run = out.runs[0];
    expect(run.tool.driver.rules).toEqual([
      {
        id: 'paths',
        shortDescription: { text: 'Documented file or directory does not exist' },
        helpUri: 'https://github.com/Fabrimat/ctxtruth#what-it-checks',
        defaultConfiguration: { level: 'error' },
      },
    ]);
    expect(run.results).toHaveLength(1);
    const result = run.results[0];
    expect(result).toMatchObject({
      ruleId: 'paths',
      level: 'error',
      message: { text: 'Path `src/gone.ts` does not exist Suggestion: src/new.ts' },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'AGENTS.md', uriBaseId: '%SRCROOT%' },
            region: { startLine: 2, startColumn: 3 },
          },
        },
      ],
    });
    expect(result.partialFingerprints['ctxtruthFingerprint/v1']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the fingerprint stable when the line moves', () => {
    const fp = (line: number) =>
      parse(formatReport(report([fail({ line })]), 'sarif', opts)).runs[0].results[0]
        .partialFingerprints['ctxtruthFingerprint/v1'];
    expect(fp(2)).toBe(fp(40));
    const other = parse(formatReport(report([fail({ value: 'src/other.ts' })]), 'sarif', opts))
      .runs[0].results[0].partialFingerprints['ctxtruthFingerprint/v1'];
    expect(other).not.toBe(fp(2));
  });

  it('hides existing and not-comparable results', () => {
    const out = parse(formatReport(compared(), 'sarif', opts));
    expect(out.runs[0].results.map((r) => r.message.text)).toEqual([
      'Code problem',
      'Docs problem',
    ]);
  });

  it('formats the drift fixture', async () => {
    const { report: r } = await check({ root: resolve('test/fixtures/drift') });
    const run = parse(formatReport(r, 'sarif', opts)).runs[0];
    expect(run.results).toHaveLength(10);
    expect(run.tool.driver.rules.map((x) => x.id)).toEqual([
      'commands',
      'paths',
      'scripts',
      'snippets',
      'symbols',
      'versions',
    ]);
  });
});
