import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/parse/index.js';
import { inlineSymbol } from '../../src/parse/symbols.js';
import { claim } from './helpers.js';

const WEAK = { shape: 'weak' };
const CALL = { call: 'true' };

describe('inlineSymbol: accepted', () => {
  it.each([
    ['createUser()', 'createUser', CALL],
    ['createUser(opts)', 'createUser', CALL],
    ['createUser({ a: 1 })', 'createUser', CALL],
    ['createUser(a, [1, (2)])', 'createUser', CALL],
    ['UserService.find()', 'UserService.find', CALL],
    ['new UserService()', 'UserService', CALL],
    ['new  UserService(a, b)', 'UserService', CALL],
    ['UserService.find', 'UserService.find', undefined],
    ['UserService#find', 'UserService.find', undefined],
    ['UserService#find()', 'UserService.find', CALL],
    ['createUser', 'createUser', WEAK],
    ['UserService', 'UserService', WEAK],
    ['parseMarkdown', 'parseMarkdown', WEAK],
    ['HTMLElement', 'HTMLElement', WEAK],
    ['toJSON', 'toJSON', WEAK],
    ['parseURL', 'parseURL', WEAK],
    ['XMLHttpRequest', 'XMLHttpRequest', WEAK],
    ['XMLHttpRequest.open()', 'XMLHttpRequest.open', CALL],
    ['toJSON.x()', 'toJSON.x', CALL],
    ['res.send()', 'res.send', { ...CALL, ...WEAK }],
    ['Foo.bar', 'Foo.bar', WEAK],
    ['fs.readFile', 'fs.readFile', WEAK],
    ['foo.bar.baz()', 'foo.bar.baz', { ...CALL, ...WEAK }],
  ])('%s', (code, value, meta) => {
    expect(inlineSymbol(code)).toEqual({ value, meta: meta ?? {} });
  });
});

describe('inlineSymbol: rejected', () => {
  it.each([
    'true',
    'null',
    'undefined',
    'this',
    'string',
    'this.state',
    'NODE_ENV',
    'MAX_RETRIES',
    'API',
    'build',
    'dist',
    'my_value',
    'React',
    'Node',
    'tiny',
    'fnA',
    'foo bar',
    'new UserService',
    'createUser(',
    'createUser(a))',
    'createUser(a) + 1',
    'createUser(a).then()',
    "'createUser'",
    'a = b',
    'a => b',
    'Array<string>',
    '@scope/pkg',
    '@Injectable()',
    '$store',
    '-flag',
    'createUser();',
    'a..b',
    '.foo',
    'foo.',
    'e.g',
    'i.e',
    'Node.js',
    'config.json',
    'run.exe',
    'setup.py',
    'os.homedir',
    'user.name',
    'a+b',
    'if(x)',
    'x()',
    '',
  ])('%s', (code) => {
    expect(inlineSymbol(code)).toBeNull();
  });
});

describe('symbol claims through parseMarkdown', () => {
  it('reports line and col of the code text', () => {
    const md = '# Title\n\nCall `createUser()` then see  `UserService.find`.\n';
    expect(parseMarkdown(md, 'AGENTS.md')).toEqual([
      claim({
        kind: 'symbol',
        value: 'createUser',
        line: 3,
        col: 7,
        section: ['Title'],
        meta: { call: 'true' },
      }),
      claim({ kind: 'symbol', value: 'UserService.find', line: 3, col: 32, section: ['Title'] }),
    ]);
  });

  it('keeps paths, versions and commands out of the symbol lane', () => {
    const kinds = parseMarkdown('`src/index.ts` `pnpm build` `createUser`', 'A.md').map(
      (c) => c.kind,
    );
    expect(kinds).toEqual(['path', 'script', 'symbol']);
  });
});
