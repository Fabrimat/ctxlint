import { describe, expect, it } from 'vitest';
import { SYSTEM_BINARIES, commandsCheck } from '../../src/checks/commands.js';
import type { CheckResult, Claim } from '../../src/types.js';
import { makeClaim, makeCtx, makeIndex } from '../helpers/repo.js';

const claim = (value: string): Claim => makeClaim({ kind: 'command', value });

const ctx = makeCtx(
  makeIndex({
    packages: [
      { dir: '', deps: { typescript: '5', vitest: '1' }, bins: ['eslint', 'ctxtruth'] },
      { dir: 'packages/app', deps: { '@playwright/test': '1', 'my-cli': '1' }, bins: [] },
    ],
  }),
);
const run = async (v: string) => (await commandsCheck.run([claim(v)], ctx))[0] as CheckResult;

describe('commands check', () => {
  it('exports the system binary list', () => {
    expect(SYSTEM_BINARIES.has('git')).toBe(true);
    expect(SYSTEM_BINARIES.has('docker-compose')).toBe(true);
    expect(SYSTEM_BINARIES.has('tsc')).toBe(false);
  });

  it('system binaries are unknown', async () => {
    const c = claim('git');
    expect(await commandsCheck.run([c], ctx)).toEqual([
      {
        claim: c,
        checkId: 'commands',
        status: 'unknown',
        reason: 'system binary',
        resolvedFiles: [],
      },
    ]);
  });

  it('passes via bins', async () => {
    expect(await run('eslint')).toMatchObject({ status: 'pass', resolvedFiles: ['package.json'] });
  });

  it('passes for the repo own declared bin', async () => {
    expect(await run('ctxtruth')).toMatchObject({
      status: 'pass',
      resolvedFiles: ['package.json'],
    });
  });

  it('passes via a same-named dependency', async () => {
    expect(await run('my-cli')).toMatchObject({
      status: 'pass',
      resolvedFiles: ['packages/app/package.json'],
    });
    expect(await run('vitest')).toMatchObject({ status: 'pass', resolvedFiles: ['package.json'] });
  });

  it('passes via the known bin to package mapping', async () => {
    expect(await run('tsc')).toMatchObject({ status: 'pass', resolvedFiles: ['package.json'] });
    expect(await run('playwright')).toMatchObject({
      status: 'pass',
      resolvedFiles: ['packages/app/package.json'],
    });
  });

  it('fails as a warning otherwise', async () => {
    const c = claim('turbo');
    const strict = makeCtx(ctx.index, 'error');
    expect(await commandsCheck.run([c], strict)).toEqual([
      {
        claim: c,
        checkId: 'commands',
        status: 'fail',
        finding: {
          file: c.file,
          line: c.line,
          col: c.col,
          checkId: 'commands',
          severity: 'warning',
          message: 'Command `turbo` is not installed as a dependency',
        },
        resolvedFiles: [],
      },
    ]);
  });
});
