import { afterEach, describe, expect, it } from 'vitest';
import { installedVersion } from '../../src/index/versions.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function repo(files: Record<string, string>) {
  const r = makeTmpRepo(files);
  cleanups.push(r.cleanup);
  return r.dir;
}

const pkgJson = (version: string) => JSON.stringify({ name: 'zod', version });
const npmLock = (packages: Record<string, { version: string }>) => JSON.stringify({ packages });

describe('installedVersion: node_modules', () => {
  it('prefers the package-local node_modules, then the hoisted one', async () => {
    const dir = repo({
      'packages/a/node_modules/zod/package.json': pkgJson('3.1.0'),
      'node_modules/zod/package.json': pkgJson('4.0.0'),
      'package-lock.json': npmLock({ 'node_modules/zod': { version: '5.0.0' } }),
    });
    expect(await installedVersion(dir, 'packages/a', 'zod')).toEqual({
      version: '3.1.0',
      source: 'packages/a/node_modules/zod/package.json',
    });
    expect(await installedVersion(dir, 'packages/b', 'zod')).toEqual({
      version: '4.0.0',
      source: 'node_modules/zod/package.json',
    });
  });

  it('beats the lockfile', async () => {
    const dir = repo({
      'node_modules/@types/node/package.json': pkgJson('22.1.0'),
      'package-lock.json': npmLock({ 'node_modules/@types/node': { version: '1.0.0' } }),
    });
    expect((await installedVersion(dir, '', '@types/node'))?.version).toBe('22.1.0');
  });
});

describe('installedVersion: package-lock.json', () => {
  const lock = npmLock({
    'node_modules/zod': { version: '3.22.4' },
    'packages/a/node_modules/zod': { version: '4.1.2' },
  });

  it('reads the workspace entry, then the root entry', async () => {
    const dir = repo({ 'package-lock.json': lock });
    expect(await installedVersion(dir, 'packages/a', 'zod')).toEqual({
      version: '4.1.2',
      source: 'package-lock.json',
    });
    expect((await installedVersion(dir, 'packages/b', 'zod'))?.version).toBe('3.22.4');
    expect(await installedVersion(dir, '', 'missing')).toBeUndefined();
  });

  it('ignores invalid JSON', async () => {
    expect(await installedVersion(repo({ 'package-lock.json': '{' }), '', 'zod')).toBeUndefined();
  });
});

describe('installedVersion: pnpm-lock.yaml', () => {
  const lock = [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      react:',
    '        specifier: ^18.0.0',
    '        version: 18.2.0',
    '      zod:',
    '        specifier: ^3.0.0',
    '        version: 3.22.4(react@18.2.0)',
    '    devDependencies:',
    "      '@types/node':",
    '        specifier: ^22',
    '        version: 22.5.0',
    '',
    '  packages/web:',
    '    dependencies:',
    '      zod:',
    '        specifier: ^4.0.0',
    '        version: 4.1.2',
    '    optionalDependencies:',
    '      fsevents:',
    '        specifier: ^2',
    '        version: 2.3.3',
    '',
    'packages:',
    '',
    '  zod@9.9.9:',
    '    resolution: {integrity: x}',
    '',
  ].join('\n');

  it('reads root and workspace importers and strips peer suffixes', async () => {
    const dir = repo({ 'pnpm-lock.yaml': lock });
    expect(await installedVersion(dir, '', 'zod')).toEqual({
      version: '3.22.4',
      source: 'pnpm-lock.yaml',
    });
    expect((await installedVersion(dir, 'packages/web', 'zod'))?.version).toBe('4.1.2');
    expect((await installedVersion(dir, '', '@types/node'))?.version).toBe('22.5.0');
    expect((await installedVersion(dir, 'packages/web', 'fsevents'))?.version).toBe('2.3.3');
  });

  it('does not borrow another importer or the packages section', async () => {
    const dir = repo({ 'pnpm-lock.yaml': lock });
    expect(await installedVersion(dir, 'packages/web', 'react')).toBeUndefined();
    expect(await installedVersion(dir, 'packages/other', 'zod')).toBeUndefined();
  });

  it('reads v5 top-level sections with inline versions', async () => {
    const text =
      'lockfileVersion: 5.4\n\nspecifiers:\n  zod: ^3\n\ndependencies:\n  zod: 3.20.0_react@18\n';
    const dir = repo({ 'pnpm-lock.yaml': text });
    expect((await installedVersion(dir, '', 'zod'))?.version).toBe('3.20.0');
  });

  it('ignores non-semver versions (links)', async () => {
    const text =
      'importers:\n  .:\n    dependencies:\n      zod:\n        specifier: workspace:*\n        version: link:../zod\n';
    expect(await installedVersion(repo({ 'pnpm-lock.yaml': text }), '', 'zod')).toBeUndefined();
  });
});

describe('installedVersion: yarn.lock', () => {
  it('reads yarn v1', async () => {
    const text = [
      '# yarn lockfile v1',
      '',
      '"@types/node@^22.0.0":',
      '  version "22.5.0"',
      '  resolved "x"',
      '',
      'zod@^3.0.0, zod@^3.1.0:',
      '  version "3.22.4"',
      '  resolved "x"',
      '',
    ].join('\n');
    const dir = repo({ 'yarn.lock': text });
    expect(await installedVersion(dir, '', 'zod')).toEqual({
      version: '3.22.4',
      source: 'yarn.lock',
    });
    expect((await installedVersion(dir, '', '@types/node'))?.version).toBe('22.5.0');
  });

  it('reads yarn berry', async () => {
    const text = [
      '__metadata:',
      '  version: 8',
      '',
      '"zod@npm:^3.0.0":',
      '  version: 3.22.4',
      '  resolution: "zod@npm:3.22.4"',
      '',
      '"root@workspace:.":',
      '  version: 0.0.0',
      '',
    ].join('\n');
    const dir = repo({ 'yarn.lock': text });
    expect((await installedVersion(dir, '', 'zod'))?.version).toBe('3.22.4');
    expect(await installedVersion(dir, '', 'root')).toBeUndefined();
  });

  it('reads berry multi-descriptor headers with CRLF line endings', async () => {
    const text = [
      '__metadata:',
      '  version: 8',
      '',
      '"zod@npm:^3.0.0, zod@npm:^3.22.0":',
      '  version: 3.22.4',
      '',
    ].join('\r\n');
    const dir = repo({ 'yarn.lock': text });
    expect((await installedVersion(dir, '', 'zod', '^3.22.0'))?.version).toBe('3.22.4');
    expect((await installedVersion(dir, '', 'zod'))?.version).toBe('3.22.4');
  });

  it('reads v1 multi-descriptor headers with CRLF line endings', async () => {
    const text = '"zod@^3.0.0", "zod@^3.22.0":\r\n  version "3.22.4"\r\n';
    const dir = repo({ 'yarn.lock': text });
    expect((await installedVersion(dir, '', 'zod', '^3.22.0'))?.version).toBe('3.22.4');
  });

  it('uses the declared range to pick between several versions, else gives up', async () => {
    const text = 'zod@^3.0.0:\n  version "3.22.4"\n\nzod@^4.0.0:\n  version "4.1.2"\n';
    const dir = repo({ 'yarn.lock': text });
    expect((await installedVersion(dir, '', 'zod', '^4.0.0'))?.version).toBe('4.1.2');
    expect(await installedVersion(dir, '', 'zod')).toBeUndefined();
  });
});

describe('installedVersion: no information', () => {
  it('returns undefined', async () => {
    expect(await installedVersion(repo({ 'a.txt': 'x' }), '', 'zod')).toBeUndefined();
  });
});
