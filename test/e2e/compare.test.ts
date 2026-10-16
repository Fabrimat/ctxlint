import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import { check } from '../../src/run.js';
import type { Report } from '../../src/types.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const repos: ReturnType<typeof makeTmpRepo>[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

/** A git repo with `files` committed on branch `base`, then checked out as the work branch. */
function repo(files: Record<string, string>) {
  const r = makeTmpRepo({ '.gitignore': 'node_modules\n', ...files }, { git: true });
  repos.push(r);
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'base');
  r.git('branch', 'base');
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(r.dir, path)), { recursive: true });
    writeFileSync(join(r.dir, path), text);
  };
  const commit = () => {
    r.git('add', '-A');
    r.git('commit', '-q', '-m', 'change');
  };
  return { ...r, write, commit };
}

async function cli(dir: string, args: string[]) {
  let out = '';
  let err = '';
  const io: CliIO = {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    cwd: dir,
    isTTY: false,
    env: {},
  };
  const code = await main(['check', ...args], io);
  return { code, out, err };
}

const newOnly = (root: string) => check({ root, base: 'base', newOnly: true });
const reported = (report: Report) =>
  report.findings.map((f) => `${f.file}:${f.line} ${f.introducedBy ?? '-'}`);

const DOC = '# Guide\n\nThe entry is `src/a.ts` and the helper is `src/b.ts`.\n';

describe('--new-only', () => {
  it('reports a claim an unchanged doc lost through a code change', async () => {
    const r = repo({ 'AGENTS.md': DOC, 'src/a.ts': 'export {};\n', 'src/b.ts': 'export {};\n' });
    renameSync(join(r.dir, 'src/a.ts'), join(r.dir, 'src/main.ts'));
    r.commit();
    const { report } = await newOnly(r.dir);
    expect(reported(report)).toEqual(['AGENTS.md:3 code']);
    expect(report.comparison).toMatchObject({ base: 'base', introduced: 1, existing: 0 });
    expect(report.summary.errors).toBe(1);
  });

  it('reports a broken path added in the docs', async () => {
    const r = repo({ 'AGENTS.md': DOC, 'src/a.ts': '', 'src/b.ts': '' });
    r.write('AGENTS.md', `${DOC}\nAlso see \`src/missing.ts\`.\n`);
    const { report } = await newOnly(r.dir);
    expect(reported(report)).toEqual(['AGENTS.md:5 docs']);
  });

  it('hides failures that already existed, even under a renamed heading', async () => {
    const r = repo({ 'AGENTS.md': DOC, 'src/a.ts': '' });
    r.write('AGENTS.md', `# Renamed guide\n\nIntro.\n\n${DOC.split('\n\n')[1]}\n`);
    r.commit();
    const { report } = await newOnly(r.dir);
    expect(report.findings).toEqual([]);
    expect(report.comparison).toMatchObject({ introduced: 0, existing: 1 });
    expect(report.summary).toMatchObject({ errors: 0, fail: 1 });
    expect(report.files[0]?.freshness).toBe(0.5);
  });

  it('counts duplicate claims', async () => {
    const twice = '# A\n\n`src/x.ts`\n\n`src/x.ts`\n';
    const r = repo({ 'AGENTS.md': twice, 'src/index.ts': '' });
    r.write('AGENTS.md', `${twice}\n\`src/x.ts\`\n`);
    const { report } = await newOnly(r.dir);
    expect(reported(report)).toEqual(['AGENTS.md:7 docs']);
    expect(report.comparison).toMatchObject({ introduced: 1, existing: 2 });
  });

  it('follows a doc renamed since the base', async () => {
    const r = repo({ 'docs/old.md': DOC, 'src/a.ts': '' });
    mkdirSync(join(r.dir, 'docs/guide'));
    r.git('mv', 'docs/old.md', 'docs/guide/new.md');
    const { report } = await newOnly(r.dir);
    expect(report.findings).toEqual([]);
    expect(report.comparison).toMatchObject({ introduced: 0, existing: 1 });
    const scoped = await check({
      root: r.dir,
      cwd: r.dir,
      paths: ['docs/guide/new.md'],
      base: 'base',
      newOnly: true,
    });
    expect(scoped.report.comparison).toMatchObject({ introduced: 0, existing: 1 });
  });

  it('counts fixed claims', async () => {
    const r = repo({ 'AGENTS.md': DOC, 'src/a.ts': '' });
    r.write('src/b.ts', '');
    const { report } = await newOnly(r.dir);
    expect(report.comparison).toMatchObject({ introduced: 0, existing: 0, fixed: 1 });
  });

  it('resolves installed packages at the base from the head checkout', async () => {
    const r = repo({
      'package.json': '{ "name": "app", "dependencies": { "pkg": "1.0.0" } }',
      'README.md': "# App\n\n```ts\nimport { nope } from 'pkg';\n```\n",
      'src/index.ts': 'export {};\n',
    });
    r.write('node_modules/pkg/package.json', '{ "name": "pkg", "types": "index.d.ts" }');
    r.write('node_modules/pkg/index.d.ts', 'export declare const yes: number;\n');
    r.write('src/other.ts', 'export {};\n');
    r.commit();
    const { report } = await newOnly(r.dir);
    expect(report.summary.fail).toBe(1);
    expect(report.findings).toEqual([]);
    expect(report.comparison).toMatchObject({ introduced: 0, existing: 1 });
  });
});

describe('--new-only edge cases', () => {
  it('does not fake a version failure as new when the base has no readable lockfile', async () => {
    const r = repo({
      'package.json': '{ "name": "app", "dependencies": { "react": ">=17" } }',
      'README.md': '# App\n\nUse `react@^17`.\n',
      'src/index.ts': 'export {};\n',
    });
    r.write('node_modules/react/package.json', '{ "name": "react", "version": "18.3.1" }');
    r.write('src/other.ts', 'export {};\n');
    r.commit();
    const { report } = await newOnly(r.dir);
    expect(report.summary.fail).toBe(1);
    expect(report.findings).toEqual([]);
    expect(report.comparison).toMatchObject({ introduced: 0, notComparable: 1 });
  });

  it('treats a --root added since the base as empty there', async () => {
    const r = repo({ 'README.md': '# Root\n' });
    r.write('pkg/AGENTS.md', '# Pkg\n\n`src/missing.ts`\n');
    r.write('pkg/src/index.ts', '');
    r.commit();
    const { report } = await check({ root: join(r.dir, 'pkg'), base: 'base', newOnly: true });
    expect(reported(report)).toEqual(['AGENTS.md:3 docs']);
  });
});

describe('--changed-only', () => {
  it('keeps claims whose resolved files changed and drops the rest', async () => {
    const r = repo({ 'AGENTS.md': DOC, 'src/a.ts': '', 'src/b.ts': '' });
    r.write('src/a.ts', 'export const a = 1;\n');
    r.commit();
    const { report } = await check({ root: r.dir, base: 'base', changedOnly: true });
    expect(report.files.flatMap((f) => f.results.map((x) => x.claim.value))).toEqual(['src/a.ts']);
  });

  it('keeps a claim whose module was deleted when combined with --new-only', async () => {
    const doc = "# A\n\n```ts\nimport { a } from './src/a.ts';\n```\n";
    const r = repo({ 'AGENTS.md': doc, 'src/a.ts': 'export const a = 1;\n' });
    rmSync(join(r.dir, 'src/a.ts'));
    r.write('src/b.ts', 'export {};\n');
    r.commit();
    const alone = await check({ root: r.dir, base: 'base', changedOnly: true });
    expect(alone.report.summary.claims).toBe(0);
    const both = await check({ root: r.dir, base: 'base', changedOnly: true, newOnly: true });
    expect(reported(both.report)).toEqual(['AGENTS.md:4 code']);
  });
});

describe('CLI comparison', () => {
  it('exits 1 only when findings were introduced', async () => {
    const r = repo({ 'AGENTS.md': DOC, 'src/a.ts': '', 'src/c.ts': '' });
    expect((await cli(r.dir, ['--new-only', '--base', 'base'])).code).toBe(0);
    expect((await cli(r.dir, [])).code).toBe(1);
    rmSync(join(r.dir, 'src/a.ts'));
    r.commit();
    const res = await cli(r.dir, ['--new-only', '--base', 'base', '--format', 'json']);
    expect(res.code).toBe(1);
    const json = JSON.parse(res.out) as Report;
    expect(json.comparison).toMatchObject({ base: 'base', introduced: 1, existing: 1 });
    expect(json.comparison?.baseSha).toMatch(/^[0-9a-f]{40}/);
  });

  it('phrases the markdown and agent reports as introduced by the change', async () => {
    const r = repo({ 'AGENTS.md': DOC, 'src/a.ts': '', 'src/b.ts': '' });
    rmSync(join(r.dir, 'src/a.ts'));
    r.commit();
    const md = await cli(r.dir, ['--new-only', '--base', 'base', '--format', 'markdown']);
    expect(md.out).toContain('This pull request makes **1** documentation claim false');
    const agent = await cli(r.dir, ['--new-only', '--base', 'base', '--format', 'agent']);
    expect(agent.out).toContain('(code change) AGENTS.md:3:');
  });

  it('ignores --base without a comparison flag, even outside git', async () => {
    const r = makeTmpRepo({ 'AGENTS.md': '# A\n\n`src/a.ts`\n', 'src/a.ts': '' });
    repos.push(r);
    const res = await cli(r.dir, ['--base', 'origin/main']);
    expect(res).toMatchObject({ code: 0, err: '' });
  });

  it('exits 2 naming the fix when the base ref is missing', async () => {
    const r = repo({ 'AGENTS.md': DOC });
    const res = await cli(r.dir, ['--new-only', '--base', 'origin/main']);
    expect(res.code).toBe(2);
    expect(res.err).toContain('fetch-depth: 0');
  });

  it('exits 2 outside a git repository', async () => {
    const r = makeTmpRepo({ 'AGENTS.md': '# A\n' });
    repos.push(r);
    const res = await cli(r.dir, ['--changed-only', '--base', 'main']);
    expect(res.code).toBe(2);
    expect(res.err).toContain('git repository');
  });
});
