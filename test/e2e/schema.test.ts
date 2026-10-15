import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import {
  blameSchema,
  generateSchemas,
  historyEpisodeSchema,
  historySchema,
  reportSchema,
} from '../../src/schema/index.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const root = resolve(import.meta.dirname, '../..');
const fixture = (name: string): string => join(root, 'test/fixtures', name);

async function run(cwd: string, args: string[]) {
  let out = '';
  const io: CliIO = { stdout: (s) => (out += s), stderr: () => {}, cwd, isTTY: false, env: {} };
  await main(args, io);
  return out;
}

const repos: ReturnType<typeof makeTmpRepo>[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

/** Commits on consecutive days; `day` is a closure so dates are deterministic. */
function gitRepo(files: Record<string, string>) {
  const r = makeTmpRepo({ '.gitignore': 'node_modules\n', ...files }, { git: true });
  repos.push(r);
  let day = 1;
  const commit = (msg: string) => {
    r.git('add', '-A');
    const date = `2026-01-${String(day++).padStart(2, '0')}T10:00:00Z`;
    const cfg = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
    execFileSync('git', ['-C', r.dir, ...cfg, 'commit', '-q', '-m', msg], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(r.dir, path)), { recursive: true });
    writeFileSync(join(r.dir, path), text);
  };
  return { ...r, commit, write };
}

const DOC = '# Guide\n\nThe entry is `src/a.ts`; run `npm run build`.\n';
const files = {
  'AGENTS.md': DOC,
  'src/a.ts': 'export {};\n',
  'package.json': '{"scripts":{"build":"tsc"}}\n',
};

describe('published schemas', () => {
  it('match the committed files (run `pnpm build && pnpm schema` after a schema change)', () => {
    for (const [file, text] of Object.entries(generateSchemas())) {
      expect(readFileSync(join(root, 'schema', file), 'utf8'), file).toBe(text);
    }
  });

  it('describe the real check output', async () => {
    for (const name of ['drift', 'clean']) {
      const report = reportSchema.parse(
        JSON.parse(await run(fixture(name), ['check', '--format', 'json'])),
      );
      expect(report.findings.length > 0).toBe(name === 'drift');
    }
  });

  it('describe a --new-only report with comparison and baseline', async () => {
    const r = gitRepo(files);
    r.commit('base');
    r.git('branch', 'base');
    renameSync(join(r.dir, 'src/a.ts'), join(r.dir, 'src/main.ts'));
    r.commit('rename');
    const out = await run(r.dir, ['check', '--format', 'json', '--base', 'base', '--new-only']);
    const report = reportSchema.parse(JSON.parse(out));
    expect(report.comparison?.introduced).toBe(1);
    expect(report.findings[0]?.introducedBy).toBe('code');
    expect(report.files.flatMap((f) => f.results).some((x) => x.baseline === 'new')).toBe(true);
  });

  it('describe a plugin finding', async () => {
    const plugin = readFileSync(join(fixture('plugins'), 'fake.mjs'), 'utf8');
    const r = gitRepo({
      'AGENTS.md': 'Content `id:alpha` and `id:gone`.\n',
      'ids.txt': 'alpha beta\n',
      'plugins/fake.mjs': plugin,
      'ctxtruth.config.json': JSON.stringify({ plugins: [['./plugins/fake.mjs', {}]] }),
    });
    const report = reportSchema.parse(JSON.parse(await run(r.dir, ['check', '--format', 'json'])));
    expect(report.findings.map((f) => f.checkId)).toContain('fake/ids');
  });

  it('describe blame json', { timeout: 60_000 }, async () => {
    const r = gitRepo(files);
    r.commit('one');
    r.git('mv', 'src/a.ts', 'src/b.ts');
    r.commit('two');
    r.write('AGENTS.md', `${DOC}Also \`src/never.ts\` and \`src/conf.ts\`.\n`);
    r.write('src/conf.ts', 'export {};\n');
    r.commit('three');
    r.git('rm', '-q', 'src/conf.ts');
    const report = blameSchema.parse(JSON.parse(await run(r.dir, ['blame', '--format', 'json'])));
    expect(new Set(report.findings.map((b) => b.cause))).toEqual(
      new Set(['broken-by', 'stale-when-written', 'uncommitted']),
    );
    expect(report.findings.some((b) => b.changes?.[0]?.status === 'renamed')).toBe(true);
  });

  it('describe history jsonl and json', { timeout: 60_000 }, async () => {
    const r = gitRepo(files);
    r.commit('init');
    r.git('mv', 'src/a.ts', 'src/b.ts');
    r.commit('rename');
    r.write('AGENTS.md', DOC.replace('src/a.ts', 'src/b.ts'));
    r.commit('fix docs');
    r.write('AGENTS.md', `${DOC.replace('src/a.ts', 'src/b.ts')}Also \`src/ghost.ts\`.\n`);
    r.commit('bad docs');
    const jsonl = await run(r.dir, ['history', '--format', 'jsonl']);
    const eps = jsonl
      .trim()
      .split('\n')
      .map((l) => historyEpisodeSchema.parse(JSON.parse(l)));
    expect(eps.some((e) => e.closedAt) && eps.some((e) => !e.closedAt)).toBe(true);
    const json = historySchema.parse(JSON.parse(await run(r.dir, ['history', '--format', 'json'])));
    expect(json.episodes).toEqual(eps);
  });

  it('reject undocumented fields', async () => {
    const report = JSON.parse(await run(fixture('clean'), ['check', '--format', 'json']));
    expect(() => reportSchema.parse({ ...report, extra: 1 })).toThrow();
  });
});
