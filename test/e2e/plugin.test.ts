import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import type { BlameReport } from '../../src/blame.js';
import type { Report } from '../../src/types.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const PLUGIN = readFileSync(resolve(import.meta.dirname, '../fixtures/plugins/fake.mjs'), 'utf8');

const DOC = [
  '# Guide',
  '',
  'Content `id:alpha` and `id:gone`.',
  '',
  'Run `fakecli build --x` and `fakecli deploy`.',
  '',
  '```sh',
  'fakecli build --y',
  '```',
  '',
  '```fakeconf',
  'port=3000',
  '```',
  '',
  'See [ok](fake:ok) and [down](fake:down). Also `broken:x`.',
  '',
].join('\n');

const repos: ReturnType<typeof makeTmpRepo>[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

/** Two commits: the second changes config.json, which breaks the `fakeconf` block. */
function setup(config: Record<string, unknown> = {}) {
  const r = makeTmpRepo(
    {
      'AGENTS.md': DOC,
      'ids.txt': 'alpha beta\n',
      'config.json': '{"port":3000}\n',
      'plugins/fake.mjs': PLUGIN,
      'ctxtruth.config.json': JSON.stringify({
        plugins: [['./plugins/fake.mjs', { subcommands: ['build', 'serve'] }]],
        ...config,
      }),
    },
    { git: true },
  );
  repos.push(r);
  let n = 0;
  const commit = (msg: string) => {
    n++;
    r.git('add', '-A');
    const date = `2026-01-0${n}T10:00:00Z`;
    const cfg = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
    execFileSync('git', ['-C', r.dir, ...cfg, 'commit', '-q', '-m', msg], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  };
  commit('docs');
  writeFileSync(join(r.dir, 'config.json'), '{"port":4000}\n');
  commit('port');
  return r.dir;
}

async function run(cwd: string, args: string[]) {
  let out = '';
  let err = '';
  const io: CliIO = {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    cwd,
    isTTY: false,
    env: {},
  };
  return { code: await main(args, io), out, err };
}

describe('plugins end to end', () => {
  it('reports plugin findings in every format', async () => {
    const dir = setup();
    const json = await run(dir, ['check', '--format', 'json']);
    expect(json.code).toBe(1);
    const report = JSON.parse(json.out) as Report;
    expect(report.findings.map((f) => [f.checkId, f.line, f.severity, f.message])).toEqual([
      ['fake/ids', 3, 'error', 'Content id `gone` does not exist'],
      ['fake/cli', 5, 'warning', 'Unknown fakecli command `deploy`'],
      ['fake/cli', 8, 'warning', 'Unknown flag `--y`'],
      ['fake/config', 12, 'warning', 'config.json has port=4000'],
      ['fake/env', 15, 'warning', 'fake:down is not reachable'],
    ]);
    const results = report.files.flatMap((f) => f.results);
    expect(results.find((r) => r.checkId === 'fake/broken')).toMatchObject({
      status: 'unknown',
      reason: 'plugin fake: invalid verdict',
    });
    // Adopted, so not a built-in command claim.
    expect(results.some((r) => r.checkId === 'commands')).toBe(false);

    const sarif = await run(dir, ['check', '--format', 'sarif']);
    expect(sarif.out).toContain('"text": "Documented content id does not exist"');
    expect(sarif.out).toContain('"ruleId": "fake/env"');
    for (const format of ['text', 'markdown', 'agent']) {
      const out = (await run(dir, ['check', '--format', format])).out;
      expect(out, format).toContain('Content id `gone` does not exist');
      expect(out, format).toContain('fake/cli');
    }
  });

  it('adopts claims of a check turned off, without running it', async () => {
    const dir = setup({ rules: { 'fake/cli': 'off' } });
    const report = JSON.parse((await run(dir, ['check', '--format', 'json'])).out) as Report;
    const ids = report.files.flatMap((f) => f.results).map((r) => r.checkId);
    expect(ids).not.toContain('fake/cli');
    expect(ids).not.toContain('commands');
  });

  it('attributes a new plugin finding with --new-only', async () => {
    const dir = setup();
    const { out } = await run(dir, ['check', '--new-only', '--base', 'HEAD~1', '--format', 'json']);
    const report = JSON.parse(out) as Report;
    expect(report.findings.map((f) => [f.checkId, f.introducedBy])).toEqual([
      ['fake/config', 'code'],
    ]);
    // The environment check is unknown at the base, so not comparable rather than new.
    expect(report.comparison).toMatchObject({ introduced: 1, existing: 3, notComparable: 1 });
  });

  it('blames plugin findings; an environment check stays undetermined', async () => {
    const dir = setup();
    const { out } = await run(dir, ['blame', '--format', 'json']);
    const report = JSON.parse(out) as BlameReport;
    const cause = (id: string) =>
      report.findings.filter((f) => f.finding.checkId === id).map((f) => f.cause);
    expect(cause('fake/config')).toEqual(['broken-by']);
    expect(cause('fake/ids')).toEqual(['stale-when-written']);
    expect(cause('fake/env')).toEqual(['undetermined']);
  });

  it('records plugin episodes in history, none for an environment check', async () => {
    const dir = setup();
    const { out } = await run(dir, ['history', '--format', 'jsonl']);
    const episodes = out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { check: string; cause: string });
    expect(episodes.map((e) => [e.check, e.cause]).sort()).toEqual([
      ['fake/cli', 'unknown'],
      ['fake/cli', 'unknown'],
      ['fake/config', 'code'],
      ['fake/ids', 'unknown'],
    ]);
  });
});
