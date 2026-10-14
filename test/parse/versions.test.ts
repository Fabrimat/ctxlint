import { describe, expect, it } from 'vitest';
import { inlineVersion } from '../../src/parse/versions.js';

describe('inlineVersion', () => {
  it.each([
    ['zod@3', 'zod', '3'],
    ['zod@3.22.4', 'zod', '3.22.4'],
    ['zod@^3.22', 'zod', '^3.22'],
    ['@types/node@22', '@types/node', '22'],
    ['react@18.x', 'react', '18.x'],
    ['zod@>=3 <4', undefined, undefined],
  ])('accepts %s', (code, pkg, range) => {
    expect(inlineVersion(code)).toEqual(pkg ? { value: code, meta: { pkg, range } } : null);
  });

  it.each([
    'zod@latest',
    'zod@next',
    'zod@canary',
    'node@22',
    'npm@10',
    'user@example.com',
    'https://x.dev/a@1.2',
    'zod @3',
    'zod@3 extra',
    'Zod@3',
    '@scope@1',
    '@scope/@1',
    'zod@',
    'zod',
    '@types/node',
    'zod@x',
    'a/b@1',
  ])('rejects %s', (code) => {
    expect(inlineVersion(code)).toBeNull();
  });
});
