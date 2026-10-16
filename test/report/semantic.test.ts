import { describe, expect, it } from 'vitest';
import { formatReport } from '../../src/report/index.js';
import type { CheckResult } from '../../src/types.js';
import { fail, opts, pass, report } from './make.js';

function drift(fix = true): CheckResult {
  return {
    claim: {
      kind: 'section',
      value: 'Server',
      file: 'AGENTS.md',
      line: 5,
      col: 1,
      section: ['Server'],
      source: 'prose',
    },
    checkId: 'semantic',
    status: 'fail',
    finding: {
      file: 'AGENTS.md',
      line: 6,
      col: 1,
      checkId: 'semantic',
      severity: 'warning',
      message: 'Possible drift: "port 3000 | <b>": PORT is 8080 @team',
      model: 'claude-haiku-5-5',
      ...(fix && {
        proposedFix: { startLine: 6, endLine: 6, replacement: 'Port 8080.\nSecond line.' },
      }),
    },
    resolvedFiles: ['src/server.ts'],
  };
}

function semanticPass(): CheckResult {
  const { finding: _, ...rest } = drift();
  void _;
  return { ...rest, status: 'pass' };
}

describe('semantic findings in the reports', () => {
  it('leave freshness and the verified counts alone', () => {
    const r = report([pass(), drift(), semanticPass()]);
    expect(r.summary).toMatchObject({ pass: 1, fail: 0, freshness: 1, warnings: 1 });
    expect(r.files[0]?.freshness).toBe(1);
    expect(r.findings).toHaveLength(1);
  });

  it('agent: a separate unverified block after the verified one', () => {
    const out = formatReport(report([fail({ line: 2, message: 'm1' }), drift()]), 'agent', opts);
    expect(out).toBe(
      [
        'ctxtruth: 1 stale claim in 1 file. These facts were verified against the repository; trust them over the docs.',
        'AGENTS.md:2:3 [error paths] m1',
        '1 possible semantic drift, judged by claude-haiku-5-5, not verified; read the code before editing.',
        'AGENTS.md:6 [warning semantic] "port 3000 | <b>": PORT is 8080 @team',
        '  → proposed (claude-haiku-5-5, unverified): replace lines 6-6 with: Port 8080.⏎Second line.',
        'To fix: edit the docs at the positions above so they match the repository; re-run `ctxtruth check` to confirm.',
        'For the possible semantic drifts: confirm against the code, then fix.',
        '',
      ].join('\n'),
    );
  });

  it('agent: no "consistent" claim when only semantic drift is found', () => {
    const out = formatReport(report([pass(), drift(false)]), 'agent', opts);
    expect(out.split('\n')[0]).toBe('ctxtruth: no stale claims (1 claim verified).');
    expect(out).not.toContain('To fix:');
  });

  it('text: a separate model-judged group', () => {
    const out = formatReport(report([pass(), drift()]), 'text', opts);
    expect(out).toContain(
      'Possible semantic drift (model-judged)\n  AGENTS.md:6  warning  "port 3000 | <b>": PORT is 8080 @team\n    proposed (claude-haiku-5-5, unverified): replace lines 6-6 with: Port 8080.⏎Second line.\n',
    );
    expect(out).not.toContain('AGENTS.md  freshness');
  });

  it('markdown: a separate table, escaped through the cell helper', () => {
    const out = formatReport(report([pass(), drift()]), 'markdown', opts);
    expect(out).toContain('#### Possible semantic drift (model-judged)');
    expect(out).toContain(
      '| `AGENTS.md:6` | 🟡 warning | "port 3000 \\| &lt;b>": PORT is 8080 @‍team<br>Proposed (unverified): replace lines 6-6 with: Port 8080.⏎Second line. |',
    );
    expect(out).toContain('No documentation drift found');
  });

  it('sarif: a model-judged rule and the proposed fix', () => {
    const sarif = JSON.parse(formatReport(report([drift()]), 'sarif', opts));
    const run = sarif.runs[0];
    expect(run.tool.driver.rules[0]).toMatchObject({
      id: 'semantic',
      shortDescription: { text: expect.stringContaining('model-judged') },
    });
    expect(run.results[0].fixes).toEqual([
      {
        description: { text: 'Proposed by claude-haiku-5-5, unverified' },
        artifactChanges: [
          {
            artifactLocation: { uri: 'AGENTS.md', uriBaseId: '%SRCROOT%' },
            replacements: [
              {
                deletedRegion: { startLine: 6, endLine: 6 },
                insertedContent: { text: 'Port 8080.\nSecond line.' },
              },
            ],
          },
        ],
      },
    ]);
    const plain = JSON.parse(formatReport(report([drift(false)]), 'sarif', opts));
    expect(plain.runs[0].results[0].fixes).toBeUndefined();
  });
});
