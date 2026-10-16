import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/parse/index.js';
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

describe('version mentions stated as a bound', () => {
  const bound = (md: string) =>
    parseMarkdown(md, 'AGENTS.md')
      .filter((c) => c.kind === 'version')
      .map((c) => [c.value, c.meta?.bound ?? '']);

  it('marks "as of", "since", "or later" and compatibility notes', () => {
    expect(
      bound(
        [
          'Both work as of `wrangler@4.87`.',
          'Requires `vite@6` or later.',
          '`@analogjs/vitest-angular@2.7.2` and Angular build\ntooling do not support Vitest 5.',
          'Upgrade from `zod@3` to `zod@4`.',
          'Validated with `zod@4`.',
        ].join('\n\n'),
      ),
    ).toEqual([
      ['wrangler@4.87', 'true'],
      ['vite@6', 'true'],
      ['@analogjs/vitest-angular@2.7.2', 'true'],
      ['zod@3', 'true'],
      ['zod@4', ''],
      ['zod@4', ''],
    ]);
  });
});
