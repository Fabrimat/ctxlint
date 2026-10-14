import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { symbolsCheck } from '../../src/checks/symbols.js';
import type { CheckResult, Claim } from '../../src/types.js';
import { makeClaim, makeCtx, makeIndex } from '../helpers/repo.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const loads = vi.hoisted(() => ({ n: 0 }));
vi.mock('typescript', async (orig) => {
  loads.n++;
  return orig();
});

const SOURCES: Record<string, string> = {
  'src/user.ts': [
    "import { z } from 'zod';",
    'export function createAccount() {}',
    'export function formatDateTime() {}',
    'export function LoadConfig() {}',
    'export const cfg = { port: 1, host: 2 };',
    'export const noMembers = () => 1;',
    'export class Base { baseMethod() {} }',
    'export class UserService extends Base {',
    '  findById() {}',
    '  static create() {}',
    '}',
    'export class Ext extends Missing { own() {} }',
    'export interface Shape { a: 1 }',
    'export function nested() { function helper() {} }',
    'export class Cycle1 extends Cycle2 { }',
    'export class Cycle2 extends Cycle1 { }',
  ].join('\n'),
};

let cleanup = (): void => undefined;
afterEach(() => cleanup());
beforeEach(() => {
  loads.n = 0;
});

async function run(
  value: string,
  meta?: Record<string, string>,
  severity: 'error' | 'warning' = 'warning',
  sources: Record<string, string> = SOURCES,
) {
  const repo = makeTmpRepo(sources);
  cleanup = repo.cleanup;
  const index = makeIndex({ files: Object.keys(sources), root: repo.dir });
  const claim: Claim = makeClaim({ kind: 'symbol', value, ...(meta ? { meta } : {}) });
  const [res] = await symbolsCheck.run([claim], makeCtx(index, severity));
  return res as CheckResult;
}
const finding = (r: CheckResult) => r.finding;
const STRONG = { call: 'true' };
const WEAK = { shape: 'weak' };

describe('symbols check: laziness', () => {
  it('does not import typescript when there are no symbol claims', async () => {
    expect(await symbolsCheck.run([], makeCtx(makeIndex()))).toEqual([]);
    expect(loads.n).toBe(0);
    await run('createAccount', STRONG);
    expect(loads.n).toBe(1);
  });
});

describe('symbols check: found', () => {
  it('passes a declared root with its declaring file', async () => {
    const r = await run('createAccount', STRONG);
    expect(r).toMatchObject({ status: 'pass', resolvedFiles: ['src/user.ts'] });
  });

  it('passes a declared member, including static and object literal members', async () => {
    expect((await run('UserService.findById')).status).toBe('pass');
    expect((await run('UserService.create')).status).toBe('pass');
    expect((await run('cfg.port')).status).toBe('pass');
    expect((await run('UserService.prototype')).status).toBe('pass');
  });

  it('passes an inherited member through the index', async () => {
    expect((await run('UserService.baseMethod')).status).toBe('pass');
  });

  it('is unknown for an inherited member whose base is external', async () => {
    expect(await run('Ext.other')).toMatchObject({ status: 'unknown', reason: 'inherited member' });
    expect((await run('Ext.own')).status).toBe('pass');
  });

  it('survives cyclic heritage', async () => {
    expect((await run('Cycle1.nothing')).status).toBe('fail');
  });

  it('is unknown when members are not indexed', async () => {
    for (const v of ['createAccount.run', 'noMembers.x']) {
      expect(await run(v)).toMatchObject({ status: 'unknown', reason: 'members not indexed' });
    }
  });

  it('passes nested declarations by name only', async () => {
    expect((await run('helper', WEAK)).status).toBe('pass');
    expect((await run('helper.x')).status).toBe('unknown');
  });
});

describe('symbols check: member missing', () => {
  it('fails with a suggestion for a close member name', async () => {
    const r = await run('UserService.findbyid');
    expect(r.status).toBe('fail');
    expect(finding(r)).toMatchObject({
      checkId: 'symbols',
      severity: 'warning',
      message: '`UserService` has no member `findbyid` (did you mean `findById`?)',
      suggestion: 'UserService.findById',
    });
  });

  it('suggests a unique prefix member', async () => {
    const r = await run('UserService.find');
    expect(finding(r)?.suggestion).toBe('UserService.findById');
  });

  it('fails without a suggestion when nothing is close', async () => {
    const r = await run('Shape.zzzzzz');
    expect(finding(r)?.message).toBe('`Shape` has no member `zzzzzz`');
    expect(finding(r)?.suggestion).toBeUndefined();
  });
});

describe('symbols check: root not found', () => {
  it('is unknown for globals', async () => {
    expect(await run('console.log', STRONG)).toMatchObject({ status: 'unknown', reason: 'global' });
    expect(await run('TypeError', WEAK)).toMatchObject({ status: 'unknown', reason: 'global' });
  });

  it('is unknown for external bindings', async () => {
    expect(await run('z.object', STRONG)).toMatchObject({
      status: 'unknown',
      reason: 'external (from `zod`)',
    });
  });

  it('fails a strong claim with a suggestion', async () => {
    const r = await run('createAcount', STRONG);
    expect(finding(r)).toMatchObject({
      message:
        'Symbol `createAcount` is not defined in the codebase (did you mean `createAccount`?)',
      suggestion: 'createAccount',
    });
    expect(r.resolvedFiles).toEqual(['src/user.ts']);
  });

  it('keeps the member in the suggestion', async () => {
    const r = await run('UserServise.findById');
    expect(finding(r)?.suggestion).toBe('UserService.findById');
  });

  it('is unknown for a strong claim without a confident match', async () => {
    expect(await run('totallyUnrelated', STRONG)).toMatchObject({
      status: 'unknown',
      reason: 'not found in the codebase',
    });
  });

  it('fails a weak claim only with a confident match', async () => {
    const r = await run('createAcount', WEAK);
    expect(r.status).toBe('fail');
    expect(finding(r)?.suggestion).toBe('createAccount');
  });

  it('is unknown for a weak claim without a match', async () => {
    expect(await run('totallyUnrelated', WEAK)).toMatchObject({
      status: 'unknown',
      reason: 'not found in the codebase',
    });
  });

  it('suggests case-insensitive and prefix matches', async () => {
    expect(finding(await run('loadConfig', WEAK))?.suggestion).toBe('LoadConfig');
    expect(finding(await run('formatDate', WEAK))?.suggestion).toBe('formatDateTime');
  });

  it('uses the configured severity', async () => {
    expect(finding(await run('createAcount', STRONG, 'error'))?.severity).toBe('error');
  });
});

describe('symbols check: precision guards', () => {
  const FILES = (body: string) => ({ 'a.ts': body });
  const WEAKCALL = { call: 'true', shape: 'weak' };

  it('never fails a weak chain root, even with a near local name', async () => {
    const src = FILES(["import { join } from 'node:path';", 'export const paths = 1;'].join('\n'));
    expect(await run('path.join', WEAKCALL, 'warning', src)).toMatchObject({
      status: 'unknown',
      reason: 'not found in the codebase',
    });
    expect(
      await run('res.send', WEAKCALL, 'warning', FILES('export const req = 1;')),
    ).toMatchObject({
      status: 'unknown',
      reason: 'not found in the codebase',
    });
  });

  it('rejects short-suffix and short-name matches', async () => {
    const src = FILES(['export function formatter() {}', 'export function load() {}'].join('\n'));
    expect((await run('format', WEAK, 'warning', src)).status).toBe('unknown');
    expect((await run('loan', WEAK, 'warning', src)).status).toBe('unknown');
  });

  it('is unknown for every claim when there are no JS/TS declarations', async () => {
    const r = await run('createAccount', STRONG, 'warning', { 'main.go': 'package main' });
    expect(r).toMatchObject({ status: 'unknown', reason: 'no TypeScript/JavaScript sources' });
  });

  it('is unknown for hooks and framework APIs not found in the repo', async () => {
    const src = FILES(
      ['export function useStat() {}', 'export function getStaticProp() {}'].join('\n'),
    );
    for (const v of ['useState', 'getStaticProps', 'querySelector']) {
      expect(await run(v, STRONG, 'warning', src)).toMatchObject({
        status: 'unknown',
        reason: 'framework or web API',
      });
    }
  });

  it('passes this.x assignments as class members', async () => {
    const src = FILES('export class Old { constructor() { this.x = 1; } }');
    expect((await run('Old.x', undefined, 'warning', src)).status).toBe('pass');
  });

  it('is unknown for members of an Object.assign-mutated class', async () => {
    const src = FILES(['class Old { a() {} }', 'Object.assign(Old.prototype, mixin);'].join('\n'));
    expect(await run('Old.zzz', undefined, 'warning', src)).toMatchObject({
      status: 'unknown',
      reason: 'members not indexed',
    });
  });

  it('is unknown for a missing member of a locally augmented global', async () => {
    const src = FILES('interface Response { custom: 1 }');
    expect(await run('Response.redirect', STRONG, 'warning', src)).toMatchObject({
      status: 'unknown',
      reason: 'global',
    });
  });

  it('is unknown rather than failing when a source file was skipped', async () => {
    const src = {
      'a.ts': 'export function createAccount() {}',
      'big.ts': 'export const huge = "' + 'x'.repeat(1024 * 1024) + '";',
    };
    expect(await run('createAcount', STRONG, 'warning', src)).toMatchObject({
      status: 'unknown',
      reason: 'not found in the codebase',
    });
  });
});
