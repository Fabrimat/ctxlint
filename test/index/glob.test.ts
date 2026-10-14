import { describe, expect, it } from 'vitest';
import { globToRegExp, matchesAny } from '../../src/index/glob.js';

describe('globToRegExp', () => {
  it('anchors literal segments', () => {
    expect(globToRegExp('docs/a.md').test('docs/a.md')).toBe(true);
    expect(globToRegExp('docs/a.md').test('x/docs/a.md')).toBe(false);
    expect(globToRegExp('docs/a.md').test('docs/axmd')).toBe(false);
  });

  it('* stays within a segment', () => {
    const re = globToRegExp('packages/*/package.json');
    expect(re.test('packages/a/package.json')).toBe(true);
    expect(re.test('packages/a/b/package.json')).toBe(false);
  });

  it('** crosses directories, including none', () => {
    const re = globToRegExp('docs/**/*.md');
    expect(re.test('docs/a.md')).toBe(true);
    expect(re.test('docs/x/y/a.md')).toBe(true);
    expect(re.test('other/a.md')).toBe(false);
    expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true);
  });

  it('? matches one non-slash character', () => {
    expect(globToRegExp('a?c').test('abc')).toBe(true);
    expect(globToRegExp('a?c').test('a/c')).toBe(false);
    expect(globToRegExp('a?c').test('abbc')).toBe(false);
  });

  it('is case-sensitive and escapes regex characters', () => {
    expect(globToRegExp('README.md').test('readme.md')).toBe(false);
    expect(globToRegExp('a+b(1).md').test('a+b(1).md')).toBe(true);
  });

  it('matchesAny', () => {
    expect(matchesAny('a.md', ['*.ts', '*.md'])).toBe(true);
    expect(matchesAny('a.md', ['*.ts'])).toBe(false);
  });
});
