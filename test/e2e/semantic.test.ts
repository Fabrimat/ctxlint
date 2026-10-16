import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { blame } from '../../src/blame.js';
import { history } from '../../src/history.js';
import { FakeProvider } from '../../src/llm/fake.js';
import { failing, type LlmRequest, type LlmResponse } from '../../src/llm/provider.js';
import { formatReport } from '../../src/report/index.js';
import { check, type CheckOptions, type LlmOptions } from '../../src/run.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const DOC = '# Guide\n\n## Server\n\nThe server in `src/server.ts` listens on port 3000.\n';

const repos: ReturnType<typeof makeTmpRepo>[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

/** Base commit on branch `base`, then a code change that contradicts the doc. */
function repo(prefix = '') {
  const r = makeTmpRepo(
    { [`${prefix}AGENTS.md`]: DOC, [`${prefix}src/server.ts`]: 'export const PORT = 3000;\n' },
    { git: true },
  );
  repos.push(r);
  r.git('config', 'core.autocrlf', 'false');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'base');
  r.git('branch', 'base');
  writeFileSync(join(r.dir, `${prefix}src/server.ts`), 'export const PORT = 8080;\n');
  r.git('commit', '-q', '-am', 'change the port');
  return r;
}

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 };
const answer = (req: LlmRequest<unknown>): LlmResponse<unknown> => ({
  ok: true,
  value:
    req.task === 'classify'
      ? {
          verdict: 'drift',
          quote: 'listens on port 3000',
          explanation: 'PORT is 8080 in src/server.ts',
          suggestion: 'listens on port 8080',
        }
      : {
          startLine: 5,
          endLine: 5,
          replacement: 'The server in `src/server.ts` listens on port 8080.',
        },
  usage,
  model: req.model,
  latencyMs: 1,
});

const llm = (provider: LlmOptions['provider'], over: Partial<LlmOptions> = {}): LlmOptions => ({
  enabled: true,
  fix: false,
  ...(provider && { provider }),
  ...over,
});

const run = (root: string, o: Partial<CheckOptions>) => check({ root, base: 'base', ...o });

describe('check --llm', { timeout: 60_000 }, () => {
  it('reports the semantic finding in agent and json', async () => {
    const r = repo();
    const provider = new FakeProvider(answer);
    const { report } = await run(r.dir, { llm: llm(provider) });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.prompt).toContain('-export const PORT = 3000;');
    const json = JSON.parse(formatReport(report, 'json', { color: false, verbose: false }));
    expect(json.findings).toEqual([
      {
        file: 'AGENTS.md',
        line: 5,
        col: 1,
        checkId: 'semantic',
        severity: 'warning',
        message: 'Possible drift: "listens on port 3000": PORT is 8080 in src/server.ts',
        model: 'claude-haiku-5-5',
      },
    ]);
    expect(json.llm).toMatchObject({ calls: 1, skipped: 0 });
    // Freshness and the verified counts ignore the model-judged result.
    expect(report.summary).toMatchObject({ pass: 1, fail: 0, freshness: 1, warnings: 1 });
    const agent = formatReport(report, 'agent', { color: false, verbose: false });
    expect(agent).toContain(
      'AGENTS.md:5 [warning semantic] "listens on port 3000": PORT is 8080 in src/server.ts',
    );
  });

  it('keeps it as new and caused by code with --new-only', async () => {
    const r = repo();
    const { report } = await run(r.dir, { newOnly: true, llm: llm(new FakeProvider(answer)) });
    const result = report.files[0]?.results.find((x) => x.checkId === 'semantic');
    expect(result?.baseline).toBe('new');
    expect(report.findings[0]?.introducedBy).toBe('code');
  });

  it('writes a patch git apply accepts and leaves the docs untouched', async () => {
    const r = repo();
    const patch = join(r.dir, '.git', 'fix.patch'); // untracked, removed with the repo
    const provider = new FakeProvider(answer);
    const { report } = await run(r.dir, { llm: llm(provider, { fix: true, patch }) });
    expect(provider.requests.map((q) => q.task)).toEqual(['classify', 'fix']);
    expect(report.findings[0]?.proposedFix).toEqual({
      startLine: 5,
      endLine: 5,
      replacement: 'The server in `src/server.ts` listens on port 8080.',
    });
    expect(readFileSync(join(r.dir, 'AGENTS.md'), 'utf8')).toBe(DOC);
    execFileSync('git', ['-C', r.dir, 'apply', '--check', patch]);
    expect(readFileSync(patch, 'utf8')).toContain(
      '+The server in `src/server.ts` listens on port 8080.',
    );
    expect(r.git('status', '--porcelain').toString()).toBe('');
  });

  it('writes repo-relative patch paths for a root in a subdirectory', async () => {
    const r = repo('pkg/');
    const root = join(r.dir, 'pkg');
    const patch = join(r.dir, '.git', 'fix.patch');
    await run(root, { llm: llm(new FakeProvider(answer), { fix: true, patch }) });
    expect(readFileSync(patch, 'utf8')).toContain('+++ b/pkg/AGENTS.md');
    execFileSync('git', ['-C', r.dir, 'apply', '--check', patch]);
    execFileSync('git', ['-C', root, 'apply', '--check', patch]);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(DOC);
  });

  it('names the base ref, not a flag, when there is no git repository', async () => {
    const dir = makeTmpRepo({ 'AGENTS.md': DOC, 'src/server.ts': '' });
    repos.push(dir);
    await expect(
      run(dir.dir, { llm: llm(new FakeProvider(answer), { scope: 'all' }) }),
    ).rejects.toThrow(/^comparing with a base ref needs a git repository/);
  });

  it('skips the sections over a tiny --max-cost and reports them', async () => {
    const r = repo();
    const provider = new FakeProvider(answer);
    const { report } = await run(r.dir, { llm: llm(provider, { maxCost: 0.000001 }) });
    expect(provider.requests).toHaveLength(0);
    expect(report.llm).toMatchObject({ calls: 0, skipped: 1, budgetUsd: 0.000001 });
    expect(report.findings).toEqual([]);
    const result = report.files[0]?.results.find((x) => x.checkId === 'semantic');
    expect(result).toMatchObject({ status: 'unknown', reason: 'skipped: over the cost budget' });
  });

  it('warns once without a key and keeps the sections unknown', async () => {
    const r = repo();
    const warnings: string[] = [];
    const provider = failing('fake', 'no-key', 'ANTHROPIC_API_KEY is not set');
    const { report } = await run(r.dir, {
      llm: llm(provider),
      onWarning: (w) => warnings.push(w),
    });
    expect(warnings).toEqual([
      '--llm: ANTHROPIC_API_KEY is not set; the model-judged checks were not run',
    ]);
    expect(report.summary.warnings + report.summary.errors).toBe(0);
  });

  it('needs a base for the changed scope, unless the scope is all', async () => {
    const r = repo();
    const provider = new FakeProvider(answer);
    await expect(check({ root: r.dir, llm: llm(provider) })).rejects.toThrow(/--base <ref>/);
    const { report } = await check({ root: r.dir, llm: llm(provider, { scope: 'all' }) });
    expect(report.findings.map((f) => f.checkId)).toEqual(['semantic']);
  });

  it('selects nothing for an unrelated change', async () => {
    const r = repo();
    r.git('branch', '-f', 'base', 'HEAD');
    writeFileSync(join(r.dir, 'package.json'), '{"name":"x"}\n');
    const provider = new FakeProvider(answer);
    const { report } = await run(r.dir, { llm: llm(provider) });
    expect(provider.requests).toHaveLength(0);
    expect(report.llm).toMatchObject({ calls: 0, skipped: 0 });
  });

  it('never calls the provider without --llm, nor from blame or history', async () => {
    const r = repo();
    const provider = new FakeProvider(answer);
    const plain = await run(r.dir, {});
    expect(plain.report.llm).toBeUndefined();
    await blame({ root: r.dir, llm: llm(provider) } as never);
    await history({ root: r.dir, llm: llm(provider) } as never);
    expect(provider.requests).toHaveLength(0);
  });
});
