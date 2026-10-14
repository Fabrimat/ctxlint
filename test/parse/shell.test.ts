import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/parse/index.js';
import { claim, fenced } from './helpers.js';

const fromLine = (line: string) =>
  parseMarkdown(fenced('sh', line), 'AGENTS.md').map(({ kind, value, meta }) => ({
    kind,
    value,
    meta,
  }));

const script = (value: string, meta: Record<string, string>) => ({ kind: 'script', value, meta });
const command = (value: string, meta?: Record<string, string>) => ({
  kind: 'command',
  value,
  meta,
});

describe('npm', () => {
  it.each([
    ['npm run build', [script('build', { pm: 'npm' })]],
    ['npm run-script build', [script('build', { pm: 'npm' })]],
    ['npm test', [script('test', { pm: 'npm' })]],
    ['npm t', [script('test', { pm: 'npm' })]],
    ['npm run build -- --watch', [script('build', { pm: 'npm' })]],
    ['npm run build -w pkg', [script('build', { pm: 'npm', filter: 'pkg' })]],
    ['npm run build --workspace pkg', [script('build', { pm: 'npm', filter: 'pkg' })]],
    ['npm run build --workspace=pkg', [script('build', { pm: 'npm', filter: 'pkg' })]],
    ['npm -w pkg run build', [script('build', { pm: 'npm', filter: 'pkg' })]],
    ['npm start', []],
    ['npm stop', []],
    ['npm restart', []],
    ['npm install', []],
    ['npm ci', []],
    ['npm run', []],
    ['npm', []],
  ])('%s', (line, expected) => {
    expect(fromLine(line)).toEqual(expected);
  });
});

describe('pnpm', () => {
  it.each([
    ['pnpm run build', [script('build', { pm: 'pnpm' })]],
    ['pnpm build', [script('build', { pm: 'pnpm' })]],
    ['pnpm test', [script('test', { pm: 'pnpm' })]],
    ['pnpm start', [script('start', { pm: 'pnpm' })]],
    ['pnpm build:prod -- --x', [script('build:prod', { pm: 'pnpm' })]],
    ['pnpm -F web build', [script('build', { pm: 'pnpm', filter: 'web' })]],
    ['pnpm --filter web build', [script('build', { pm: 'pnpm', filter: 'web' })]],
    ['pnpm --filter=web run build', [script('build', { pm: 'pnpm', filter: 'web' })]],
    ['pnpm -r build', [script('build', { pm: 'pnpm', recursive: 'true' })]],
    ['pnpm --recursive run build', [script('build', { pm: 'pnpm', recursive: 'true' })]],
    ['pnpm -C packages/a build', [script('build', { pm: 'pnpm', dir: 'packages/a' })]],
    ['pnpm --dir packages/a build', [script('build', { pm: 'pnpm', dir: 'packages/a' })]],
    ['pnpm --silent build', [script('build', { pm: 'pnpm' })]],
    ['pnpm exec tsc', [command('tsc', { via: 'pnpm-exec' })]],
    ['pnpm dlx create-foo', []],
    ['pnpm run', []],
    ['pnpm', []],
    ['pnpm ./local', []],
  ])('%s', (line, expected) => {
    expect(fromLine(line)).toEqual(expected);
  });
});

it.each(
  'add i install update up upgrade remove rm uninstall un link ln unlink import rebuild rb prune fetch patch patch-commit patch-remove audit outdated list ls ll why licenses create init publish pack setup env store config c get set root bin help server deploy doctor cache self-update approve-builds ignored-builds catalog'.split(
    ' ',
  ),
)('pnpm builtin %s yields nothing', (b) => {
  expect(fromLine(`pnpm ${b}`)).toEqual([]);
});

describe('yarn', () => {
  it.each([
    ['yarn', []],
    ['yarn build', [script('build', { pm: 'yarn' })]],
    ['yarn run build', [script('build', { pm: 'yarn' })]],
    ['yarn workspace web build', [script('build', { pm: 'yarn', filter: 'web' })]],
    ['yarn workspace web run build', [script('build', { pm: 'yarn', filter: 'web' })]],
    ['yarn install', []],
    ['yarn add left-pad', []],
    ['yarn workspaces foreach build', []],
    ['yarn dlx create-x', []],
  ])('%s', (line, expected) => {
    expect(fromLine(line)).toEqual(expected);
  });
});

describe('bun', () => {
  it.each([
    ['bun run dev', [script('dev', { pm: 'bun' })]],
    ['bun run ./x.ts', []],
    ['bun run a.ts', []],
    ['bun install', []],
    ['bun test', []],
  ])('%s', (line, expected) => {
    expect(fromLine(line)).toEqual(expected);
  });
});

describe('npx', () => {
  it.each([
    ['npx prettier --write .', [command('prettier', { via: 'npx' })]],
    ['npx -y pkg@1', [command('pkg', { via: 'npx' })]],
    ['npx --yes prettier@3 .', [command('prettier', { via: 'npx' })]],
    ['npx -p typescript tsc', [command('tsc', { via: 'npx' })]],
    ['npx --package typescript tsc', [command('tsc', { via: 'npx' })]],
    ['npx --package=typescript tsc', [command('tsc', { via: 'npx' })]],
    ['npx @scope/pkg@2', [command('@scope/pkg', { via: 'npx' })]],
    ['npx', []],
  ])('%s', (line, expected) => {
    expect(fromLine(line)).toEqual(expected);
  });
});

describe('other commands', () => {
  it.each([
    ['git status', [command('git')]],
    ['sudo apt install x', [command('apt')]],
    ['FOO=1 BAR="a b" node server.js', [command('node')]],
    ['cd app', []],
    ['cd app && make', [command('make')]],
    ['a; b | c || d', [command('a'), command('b'), command('c'), command('d')]],
    ['git commit -m "fix && stuff; ok"', [command('git')]],
    ["cat 'a | b' | grep b", [command('cat'), command('grep')]],
    ['npm run a && pnpm b', [script('a', { pm: 'npm' }), script('b', { pm: 'pnpm' })]],
    ['$EDITOR file', []],
    ['/usr/bin/env x', []],
    ['git status # trailing comment', [command('git')]],
  ])('%s', (line, expected) => {
    expect(fromLine(line)).toEqual(expected);
  });

  it('turns a relative-path first token into a path claim', () => {
    expect(
      parseMarkdown(fenced('sh', './scripts/setup.sh --fast', 'scripts/x.sh'), 'AGENTS.md'),
    ).toEqual([
      claim({ kind: 'path', value: './scripts/setup.sh', line: 2, col: 1, source: 'fence' }),
      claim({ kind: 'path', value: 'scripts/x.sh', line: 3, col: 1, source: 'fence' }),
    ]);
  });
});

describe('fences', () => {
  it('computes positions through indentation, prompts, comments, chains, env and continuations', () => {
    const md = [
      '# Setup',
      '## Scripts',
      '  ```bash',
      '  $ npm run build && pnpm -F web test',
      '  # comment',
      '',
      '  FOO=1 sudo npm run lint \\',
      '    -- --fix',
      '  ```',
    ].join('\n');
    const base = { section: ['Setup', 'Scripts'], source: 'fence' as const };
    expect(parseMarkdown(md, 'AGENTS.md')).toEqual([
      claim({ kind: 'script', value: 'build', line: 4, col: 13, meta: { pm: 'npm' }, ...base }),
      claim({
        kind: 'script',
        value: 'test',
        line: 4,
        col: 34,
        meta: { pm: 'pnpm', filter: 'web' },
        ...base,
      }),
      claim({ kind: 'script', value: 'lint', line: 7, col: 22, meta: { pm: 'npm' }, ...base }),
    ]);
  });

  it('maps tokens after a continuation to the continuation line', () => {
    expect(parseMarkdown(fenced('sh', 'npm run a && \\', '  make'), 'AGENTS.md')).toEqual([
      claim({ kind: 'script', value: 'a', line: 2, col: 9, meta: { pm: 'npm' }, source: 'fence' }),
      claim({ kind: 'command', value: 'make', line: 3, col: 3, source: 'fence' }),
    ]);
  });

  it('treats only prompted lines of console fences as commands', () => {
    const md = fenced(
      'console',
      '$ npm test',
      '> proj@1.0.0 test',
      '> vitest',
      'ok  src/a.ts',
      '$ git status',
    );
    expect(parseMarkdown(md, 'AGENTS.md')).toEqual([
      claim({
        kind: 'script',
        value: 'test',
        line: 2,
        col: 7,
        meta: { pm: 'npm' },
        source: 'fence',
      }),
      claim({ kind: 'command', value: 'git', line: 6, col: 3, source: 'fence' }),
    ]);
  });

  it('supports shellsession and strips prompts in plain shell fences', () => {
    expect(parseMarkdown(fenced('shellsession', '$ make', 'output'), 'AGENTS.md')).toEqual([
      claim({ kind: 'command', value: 'make', line: 2, col: 3, source: 'fence' }),
    ]);
    expect(parseMarkdown(fenced('zsh', '> make'), 'AGENTS.md')).toEqual([
      claim({ kind: 'command', value: 'make', line: 2, col: 3, source: 'fence' }),
    ]);
  });

  it('skips fences without a shell language', () => {
    expect(parseMarkdown(fenced('', 'npm run build'), 'AGENTS.md')).toEqual([]);
    expect(parseMarkdown(fenced('json', '{ "a": "npm run build" }'), 'AGENTS.md')).toEqual([]);
  });
});

describe('inline shell commands', () => {
  it('parses package-manager inline code as script claims, not paths', () => {
    expect(parseMarkdown('Use `npm run build` here', 'AGENTS.md')).toEqual([
      claim({ kind: 'script', value: 'build', line: 1, col: 14, meta: { pm: 'npm' } }),
    ]);
  });

  it('handles chains and npx inside inline code', () => {
    expect(parseMarkdown('Run ``pnpm -F web test && npx -y tsc``.', 'AGENTS.md')).toEqual([
      claim({
        kind: 'script',
        value: 'test',
        line: 1,
        col: 19,
        meta: { pm: 'pnpm', filter: 'web' },
      }),
      claim({ kind: 'command', value: 'tsc', line: 1, col: 34, meta: { via: 'npx' } }),
    ]);
  });

  it('does not treat other inline code as a command', () => {
    expect(parseMarkdown('`git status` and `node`', 'AGENTS.md')).toEqual([]);
  });
});

describe('false-positive guards', () => {
  it.each([
    ['pnpm --reporter silent build', []],
    ['pnpm --reporter=silent build', [script('build', { pm: 'pnpm' })]],
    ['pnpm --no-color build', [script('build', { pm: 'pnpm' })]],
    ['pnpm --if-present -r build', [script('build', { pm: 'pnpm', recursive: 'true' })]],
    ['pnpm run build --reporter x', [script('build', { pm: 'pnpm' })]],
    ['npm --prefix app run build', []],
    ['npx --node-arg x prettier', []],
    ['(cd x && npm run y)', [script('y', { pm: 'npm' })]],
    ['{ npm run a; }', [script('a', { pm: 'npm' })]],
    ['echo $(npm run x)', []],
    ['out=`npm run x`', []],
    ['cat <<EOF', []],
    ['if [ -f x ]; then npm test; fi', [script('test', { pm: 'npm' })]],
    ['for f in a b; do make $f; done', [command('make')]],
    ['while true; do sleep 1; done', [command('sleep')]],
    ['time npm test', [script('test', { pm: 'npm' })]],
    ['export A=1 && set -e && source env.sh && echo hi && exit 1', []],
    ['npm.cmd run build', [script('build', { pm: 'npm' })]],
    ['npm run <script>', []],
    ['pnpm {name}', []],
    ['yarn run $SCRIPT', []],
    ['npm run ...', []],
    ['pnpm.cmd build', [script('build', { pm: 'pnpm' })]],
    ['yarn.cmd build', [script('build', { pm: 'yarn' })]],
    ['npx.cmd prettier', [command('prettier', { via: 'npx' })]],
    ['bun.exe run dev', [script('dev', { pm: 'bun' })]],
    ['node.exe a.js', [command('node')]],
    ['scripts/setup', [{ kind: 'path', value: 'scripts/setup', meta: { shape: 'weak' } }]],
    ['./scripts/x.ps1', [{ kind: 'path', value: './scripts/x.ps1', meta: undefined }]],
  ])('%s', (line, expected) => {
    expect(fromLine(line)).toEqual(expected);
  });

  it('positions survive group trimming', () => {
    expect(parseMarkdown(fenced('sh', '(cd x && npm run y)'), 'AGENTS.md')).toEqual([
      claim({ kind: 'script', value: 'y', line: 2, col: 18, meta: { pm: 'npm' }, source: 'fence' }),
    ]);
  });

  it('skips heredoc bodies', () => {
    const md = fenced('sh', 'cat <<EOF', 'npm run inside', 'EOF', 'npm run after');
    expect(parseMarkdown(md, 'AGENTS.md')).toEqual([
      claim({
        kind: 'script',
        value: 'after',
        line: 5,
        col: 9,
        meta: { pm: 'npm' },
        source: 'fence',
      }),
    ]);
  });
});
