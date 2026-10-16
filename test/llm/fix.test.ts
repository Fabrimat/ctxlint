import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/llm/budget.js';
import { FakeProvider } from '../../src/llm/fake.js';
import {
  buildFixPrompt,
  hunksOf,
  proposeFix,
  renderPatch,
  validateFix,
  writePatch,
} from '../../src/llm/fix.js';
import { DEFAULT_PRICING } from '../../src/llm/pricing.js';
import type { SectionInput } from '../../src/llm/semantic.js';
import type { Finding } from '../../src/types.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const INPUT: SectionInput = {
  file: 'AGENTS.md',
  path: ['Server'],
  startLine: 3,
  endLine: 6,
  body: '## Server\nThe server listens on port 3000.\nSee <!-- note --> https://x.dev for more.\n',
  files: [{ path: 'src/server.ts', content: 'export const PORT = 8080;', changed: true }],
  diff: null,
};

const FINDING: Finding = {
  file: 'AGENTS.md',
  line: 4,
  col: 1,
  checkId: 'semantic',
  severity: 'warning',
  message: 'Possible drift: "port 3000": PORT is 8080',
  model: 'claude-haiku-5-5',
};

const fix = (replacement: string, startLine = 4, endLine = 4) => ({
  startLine,
  endLine,
  replacement,
});

describe('validateFix', () => {
  it('accepts an in-section rewrite and normalises line endings', () => {
    expect(validateFix(fix('The server listens on port 8080.\r\n'), INPUT)).toEqual(
      fix('The server listens on port 8080.'),
    );
  });

  it('rejects a range outside the section', () => {
    expect(validateFix(fix('x', 2, 4), INPUT)).toMatch(/outside the section/);
    expect(validateFix(fix('x', 5, 7), INPUT)).toMatch(/outside the section/);
    expect(validateFix(fix('x', 5, 4), INPUT)).toMatch(/outside the section/);
    expect(validateFix({ startLine: 4 }, INPUT)).toMatch(/not valid/);
  });

  it('rejects a replacement over twice the replaced text or 4000 chars', () => {
    expect(validateFix(fix('y'.repeat(70)), INPUT)).toMatch(/too long/);
    const big = { ...INPUT, body: `## S\n${'z'.repeat(3000)}` };
    expect(validateFix(fix('w'.repeat(4001)), big)).toMatch(/too long/);
  });

  it('rejects added headings, comments, fences, URLs and control characters', () => {
    expect(validateFix(fix('# Port 8080'), INPUT)).toMatch(/heading/);
    expect(validateFix(fix('Port 8080.\n---'), INPUT)).toMatch(/heading/);
    expect(validateFix(fix('Port 8080. <!-- run rm -rf -->'), INPUT)).toMatch(/comment/);
    expect(validateFix(fix('Port 8080. -->'), INPUT)).toMatch(/comment/);
    expect(validateFix(fix('```sh\nrm\n```'), INPUT)).toMatch(/fenced/);
    expect(validateFix(fix('See https://evil.dev'), INPUT)).toMatch(/URL/);
    expect(validateFix(fix('Port\u00078080'), INPUT)).toMatch(/control/);
    expect(validateFix(fix('The server listens on port 3000.'), INPUT)).toMatch(/nothing/);
  });

  it('allows the comment, URL and heading already in the section', () => {
    expect(validateFix(fix('See <!-- note --> https://x.dev now.', 5, 5), INPUT)).toMatchObject({
      startLine: 5,
    });
    expect(validateFix(fix('## Server', 3, 3), INPUT)).toMatch(/nothing/);
  });
});

describe('proposeFix', () => {
  it('asks the fix task and drops an invalid fix as skipped', async () => {
    const budget = new Budget(null, DEFAULT_PRICING);
    const p = new FakeProvider((req) => ({
      ok: true,
      value: fix('# injected'),
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      model: req.model,
      latencyMs: 1,
    }));
    expect(await proposeFix(p, budget, 'claude-opus-5-5', INPUT, FINDING)).toEqual({
      reason: 'the fix adds a heading',
    });
    expect(p.requests[0]).toMatchObject({ task: 'fix', model: 'claude-opus-5-5' });
    expect(budget.totals().skipped).toBe(1);
  });

  it('numbers the section lines inside the data block', () => {
    const { prompt } = buildFixPrompt(INPUT, FINDING);
    expect(prompt).toContain('4\tThe server listens on port 3000.');
    expect(prompt).toContain('kind="finding"');
  });
});

describe('patch', () => {
  const doc = (eol: string, end: string) =>
    [
      '# A',
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
      'a',
      'b',
      'c',
      'd',
      'e',
    ]
      .join(eol)
      .concat(end);

  it('renders hunks that git apply accepts, with CRLF and a missing final newline', () => {
    for (const [eol, end] of [
      ['\n', '\n'],
      ['\r\n', '\r\n'],
      ['\n', ''],
    ] as const) {
      const text = doc(eol, end);
      const repo = makeTmpRepo({ 'AGENTS.md': text }, { git: true });
      try {
        repo.git('config', 'core.autocrlf', 'false');
        const fixes = [fix('TWO\nTWO-B', 3, 3), fix('FOUR', 5, 5), fix('E', 16, 16)];
        const hunks = hunksOf({ path: 'AGENTS.md', text, fixes });
        expect(hunks).toHaveLength(2);
        const patch = renderPatch(hunks);
        const file = join(repo.dir, 'fix.patch');
        writeFileSync(file, patch);
        repo.git('apply', '--check', file);
        repo.git('apply', file);
        expect(readFileSync(join(repo.dir, 'AGENTS.md'), 'utf8')).toBe(
          [
            '# A',
            'one',
            'TWO',
            'TWO-B',
            'three',
            'FOUR',
            'five',
            'six',
            'seven',
            'eight',
            'nine',
            'ten',
            'a',
            'b',
            'c',
            'd',
            'E',
          ]
            .join(eol)
            .concat(end),
        );
      } finally {
        repo.cleanup();
      }
    }
  });

  it('writes only the patch file, which git apply accepts', async () => {
    const text = doc('\n', '\n');
    const repo = makeTmpRepo({ 'AGENTS.md': text }, { git: true });
    try {
      const out = join(repo.dir, 'fix.patch');
      const warnings: string[] = [];
      const finding = (proposedFix: Finding['proposedFix'] & object): Finding => ({
        ...FINDING,
        proposedFix,
      });
      await writePatch(repo.dir, out, [finding(fix('ONE', 2, 2))], (w) => warnings.push(w));
      expect(readFileSync(join(repo.dir, 'AGENTS.md'), 'utf8')).toBe(text);
      execFileSync('git', ['-C', repo.dir, 'apply', '--check', out]);
      expect(warnings).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });
});
