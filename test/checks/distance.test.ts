import { describe, expect, it } from 'vitest';
import { closest, distance, isRename } from '../../src/util/distance.js';

describe('distance', () => {
  it('counts edits, with adjacent transposition as one', () => {
    expect(distance('', 'abc')).toBe(3);
    expect(distance('kitten', 'sitting')).toBe(3);
    expect(distance('build', 'biuld')).toBe(1);
    expect(distance('same', 'same')).toBe(0);
  });
});

describe('closest', () => {
  it('returns the nearest within the limit, else undefined', () => {
    expect(closest('biuld', ['test', 'build', 'lint'], 2)).toBe('build');
    expect(closest('xyz', ['test', 'build'], 2)).toBeUndefined();
    expect(closest('a', ['a'], 2)).toBeUndefined();
  });
});

describe('isRename', () => {
  it.each([
    ['createAcount', 'createAccount', true],
    ['ModelToTable', 'ModelTable', true],
    ['.oxlintrc.json', '.oxlintrc.jsonc', true],
    ['TaskResult', 'WalkResult', false],
    ['EncodeContext', 'DecodeContext', false],
    ['createX', 'created', true],
    ['short', 'shorts', false],
    ['abcdefgh', 'xbcdefgy', false],
    ['same-name', 'same-name', false],
  ])('%s -> %s: %s', (a, b, expected) => {
    expect(isRename(a, b)).toBe(expected);
  });
});
