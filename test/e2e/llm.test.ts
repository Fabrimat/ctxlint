import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';

// Importing either SDK fails the test: a plain run must never load them.
vi.mock('@anthropic-ai/sdk', () => {
  throw new Error('@anthropic-ai/sdk must not be imported without --llm');
});
vi.mock('openai', () => {
  throw new Error('openai must not be imported without --llm');
});

const clean = resolve(import.meta.dirname, '../fixtures/clean');

async function run(args: string[]) {
  let out = '';
  let err = '';
  const code = await main(args, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    cwd: clean,
    isTTY: false,
    env: {},
  });
  return { code, out, err };
}

describe('check without --llm', () => {
  it('runs without importing an SDK', async () => {
    const { code, err } = await run(['check', '--root', clean]);
    expect(code).toBe(0);
    expect(err).toBe('');
  });
});

describe('check LLM flags', () => {
  it('validates --max-cost', async () => {
    for (const bad of ['abc', '-1', '']) {
      const { code, err } = await run(['check', '--root', clean, '--max-cost', bad]);
      expect(code).toBe(2);
      expect(err).toContain('--max-cost');
    }
    expect((await run(['check', '--root', clean, '--max-cost', 'unlimited'])).code).toBe(0);
    expect((await run(['check', '--root', clean, '--max-cost', '0.5'])).code).toBe(0);
  });

  it('validates --llm-scope', async () => {
    expect((await run(['check', '--root', clean, '--llm-scope', 'some'])).code).toBe(2);
    expect((await run(['check', '--root', clean, '--llm-scope', 'all'])).code).toBe(0);
  });

  it('accepts --llm, --fix, --patch and --llm-dump', async () => {
    for (const flags of [['--llm'], ['--fix'], ['--patch', 'x.patch'], ['--llm-dump', 'd']]) {
      expect((await run(['check', '--root', clean, ...flags])).code).toBe(0);
    }
  });

  it('is not offered by blame or history', async () => {
    expect((await run(['blame', '--llm'])).code).toBe(2);
    expect((await run(['history', '--llm'])).code).toBe(2);
  });
});
