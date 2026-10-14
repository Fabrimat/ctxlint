import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import { check } from '../../src/run.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const fixtures = resolve(import.meta.dirname, '../fixtures');
const drift = resolve(fixtures, 'drift');
const clean = resolve(fixtures, 'clean');

async function run(args: string[], io: Partial<CliIO> = {}) {
  let out = '';
  let err = '';
  const code = await main(args, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    cwd: fixtures,
    isTTY: false,
    env: {},
    ...io,
  });
  return { code, out, err };
}

const normalise = (s: string): string => s.replace(/\d+ ms/, '<N> ms');

const DRIFT_TEXT = `AGENTS.md  freshness 23% (3/13)
  6:31   error    Path \`src/utils/format.ts\` does not exist (did you mean \`src/utils/formatting.ts\`?)           paths
                  suggestion: src/utils/formatting.ts
  7:33   error    Path \`src/old/config.ts\` does not exist (moved to \`src/config.ts\`?)                           paths
                  suggestion: src/config.ts
  16:10  error    Script \`typecheck\` is not defined in \`package.json\`                                           scripts
  17:9   error    Script \`buidl\` is not defined in \`package.json\` (did you mean \`build\`?)                       scripts
                  suggestion: build
  18:6   warning  Script \`dev\` is not defined in \`package.json\` (it is defined in \`packages/web/package.json\`)  scripts
  19:1   warning  Command \`tsx\` is not installed as a dependency                                                commands
  31:31  warning  Symbol \`formatTimeStamp\` is not defined in the codebase (did you mean \`formatTimestamp\`?)     symbols
                  suggestion: formatTimestamp
  32:9   warning  \`Config\` has no member \`reload\`                                                               symbols
  33:28  warning  Docs say \`zod@3\` but \`package.json\` requires \`^4.1.0\`                                         versions
                  suggestion: zod@4
  38:29  error    Snippet does not type-check: Expected 1 arguments, but got 2. (TS2554)                        snippets

docs/guide.md  freshness 67% (2/3)
  5:24  error  Path \`../src/old/config.ts\` does not exist (moved to \`src/config.ts\`?)  paths
               suggestion: src/config.ts

✖ 6 errors, 5 warnings · 24 claims · 10 verified · 3 unknown · freshness 48% · <N> ms
`;

describe('ctxtruth check', () => {
  it('prints the drift report as text and exits 1', async () => {
    const { code, out, err } = await run(['check', '--root', drift]);
    expect(code).toBe(1);
    expect(err).toBe('');
    expect(normalise(out)).toBe(DRIFT_TEXT);
  });

  it('exits 0 on a clean repo', async () => {
    const { code, out } = await run(['check', '--root', clean]);
    expect(code).toBe(0);
    expect(normalise(out)).toBe(
      '✔ No drift found · 11 claims · 11 verified · 0 unknown · freshness 100% · <N> ms\n',
    );
  });

  it('prints JSON that matches the report', async () => {
    const { code, out } = await run(['check', '--root', drift, '--format', 'json']);
    const { report } = await check({ root: drift });
    const parsed = JSON.parse(out) as typeof report;
    expect(code).toBe(1);
    expect(parsed.findings).toEqual(report.findings);
    expect(parsed.summary).toEqual({ ...report.summary, durationMs: parsed.summary.durationMs });
    expect(parsed.version).toBe(1);
  });

  it('exits 2 on an invalid --format', async () => {
    const { code, out, err } = await run(['check', '--root', drift, '--format', 'xml']);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toContain('xml');
    expect(err).toContain('text, json');
  });

  it('exits 2 on an unknown option', async () => {
    expect((await run(['check', '--bogus'])).code).toBe(2);
  });

  describe('config errors', () => {
    let cleanup = () => {};
    afterEach(() => cleanup());

    it('exits 2 with a message and no stack for a broken config', async () => {
      const repo = makeTmpRepo({ 'ctxtruth.config.json': '{ nope', 'README.md': '# Hi\n' });
      cleanup = repo.cleanup;
      const { code, out, err } = await run(['check', '--root', repo.dir]);
      expect(code).toBe(2);
      expect(out).toBe('');
      expect(err).toMatch(/^error: Failed to load config /);
      expect(err).not.toContain('    at ');
    });

    it('exits 2 for an invalid config value', async () => {
      const repo = makeTmpRepo({ 'ctxtruth.config.json': '{"failOn":"sometimes"}' });
      cleanup = repo.cleanup;
      const { code, err } = await run(['check', '--root', repo.dir]);
      expect(code).toBe(2);
      expect(err).toContain('Invalid config');
    });

    it('exits 2 when an explicit --config does not exist', async () => {
      const { code, err } = await run(['check', '--root', clean, '--config', 'missing.json']);
      expect(code).toBe(2);
      expect(err).toContain('Config file not found');
    });
  });

  describe('--fail-on', () => {
    it('warning also fails on warnings', async () => {
      const repo = makeTmpRepo({
        'package.json': '{"scripts":{"build":"x"}}',
        'AGENTS.md': '```sh\ntsx run.ts\n```\n',
      });
      try {
        expect((await run(['check', '--root', repo.dir])).code).toBe(0);
        expect((await run(['check', '--root', repo.dir, '--fail-on', 'warning'])).code).toBe(1);
      } finally {
        repo.cleanup();
      }
    });

    it('none never fails', async () => {
      expect((await run(['check', '--root', drift, '--fail-on', 'none'])).code).toBe(0);
    });

    it('overrides the config file', async () => {
      const repo = makeTmpRepo({
        'ctxtruth.config.json': '{"failOn":"none"}',
        'package.json': '{}',
        'README.md': 'See `missing/file.ts`.\n',
      });
      try {
        expect((await run(['check', '--root', repo.dir])).code).toBe(0);
        expect((await run(['check', '--root', repo.dir, '--fail-on', 'error'])).code).toBe(1);
      } finally {
        repo.cleanup();
      }
    });
  });

  it('narrows to a path argument relative to cwd', async () => {
    const { code, out } = await run(['check', 'docs', '--root', drift], { cwd: drift });
    expect(code).toBe(1);
    expect(out).toContain('docs/guide.md');
    expect(out).not.toContain('AGENTS.md');
    expect(out).toContain('1 error · 3 claims');
  });

  it('warns on stderr when a path argument matches no document', async () => {
    const { code, err } = await run(['check', 'dcos', '--root', drift], { cwd: drift });
    expect(code).toBe(0);
    expect(err).toBe('warning: no target documents matched dcos\n');
  });

  it('--verbose lists unknown claims with their reasons', async () => {
    const { out } = await run(['check', '--root', drift, '--verbose']);
    expect(out).toContain('unknown  path `dist` — gitignored');
    expect(out).toContain('unknown  path `react-dom/client` — not a repository path');
    expect(out).toContain('unknown  command `git` — system binary');
    expect((await run(['check', '--root', drift])).out).not.toContain('unknown  ');
  });

  describe('colour', () => {
    const ESC = '\u001b[';
    const args = ['check', '--root', drift];

    it('is off when not a TTY', async () => {
      expect((await run(args)).out).not.toContain(ESC);
    });

    it('is on for a TTY, unless NO_COLOR or --no-color', async () => {
      expect((await run(args, { isTTY: true })).out).toContain(ESC);
      expect((await run(args, { isTTY: true, env: { NO_COLOR: '1' } })).out).not.toContain(ESC);
      expect((await run([...args, '--no-color'], { isTTY: true })).out).not.toContain(ESC);
    });

    it('is forced by FORCE_COLOR but never for json', async () => {
      expect((await run(args, { env: { FORCE_COLOR: '1' } })).out).toContain(ESC);
      expect((await run(args, { env: { FORCE_COLOR: '0' } })).out).not.toContain(ESC);
      const json = await run([...args, '--format', 'json'], { env: { FORCE_COLOR: '1' } });
      expect(json.out).not.toContain(ESC);
    });
  });

  describe('format selection', () => {
    it('defaults to the agent format when a coding agent runs the command', async () => {
      const { out } = await run(['check', '--root', drift], { env: { CLAUDECODE: '1' } });
      expect(out).toMatch(/^ctxtruth: 11 stale claims in 2 files./);
    });

    it('lets CTXTRUTH_FORMAT and --format override the default', async () => {
      const env = { CLAUDECODE: '1', CTXTRUTH_FORMAT: 'json' };
      expect(JSON.parse((await run(['check', '--root', clean], { env })).out)).toMatchObject({
        version: 1,
      });
      const text = await run(['check', '--root', clean, '--format', 'text'], { env });
      expect(text.out).toMatch(/^✔ No drift found/);
    });
  });

  describe('output files', () => {
    let cleanup = () => {};
    afterEach(() => cleanup());

    it('--output writes the report to a file and --sarif adds a SARIF file', async () => {
      const repo = makeTmpRepo({});
      cleanup = repo.cleanup;
      const out = join(repo.dir, 'report.md');
      const sarif = join(repo.dir, 'report.sarif');
      const res = await run([
        'check',
        '--root',
        drift,
        '--format',
        'markdown',
        '--output',
        out,
        '--sarif',
        sarif,
      ]);
      expect(res.code).toBe(1);
      expect(res.out).toBe('');
      expect(readFileSync(out, 'utf8').startsWith('<!-- ctxtruth-report -->')).toBe(true);
      expect(JSON.parse(readFileSync(sarif, 'utf8'))).toMatchObject({ version: '2.1.0' });
    });
  });

  it('exits 2 when --changed-only or --new-only has no base ref', async () => {
    for (const flag of ['--changed-only', '--new-only']) {
      const { code, err } = await run(['check', '--root', drift, flag]);
      expect(code).toBe(2);
      expect(err).toContain('--base <ref>');
    }
  });

  it('--help and --version exit 0', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('check');
    const version = await run(['--version']);
    expect(version.code).toBe(0);
    expect(version.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
