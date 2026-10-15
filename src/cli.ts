#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CommanderError, Command, Option } from 'commander';
import type { HistoryFormat } from './report/history.js';
import type { Severity } from './types.js';

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: string;
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
}

type Format = 'text' | 'json' | 'sarif' | 'markdown' | 'agent';

interface CheckFlags {
  format?: Format;
  base?: string;
  changedOnly?: boolean;
  newOnly?: boolean;
  untrusted?: boolean;
  linkBase?: string;
  output?: string;
  sarif?: string;
  config?: string;
  root?: string;
  failOn?: 'error' | 'warning' | 'none';
  verbose?: boolean;
  color: boolean;
}

const version = (): string =>
  (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;

/** Environment variables set by coding agents when they run shell commands. */
const AGENT_ENV = ['CLAUDECODE', 'GEMINI_CLI'];

/** --format, then CTXTRUTH_FORMAT, then `agent` when a coding agent runs the command, else `text`. */
function resolveFormat(flags: CheckFlags, io: CliIO): Format {
  if (flags.format) return flags.format;
  const fromEnv = io.env['CTXTRUTH_FORMAT'];
  if (fromEnv !== undefined && FORMATS.includes(fromEnv as Format)) return fromEnv as Format;
  return AGENT_ENV.some((k) => io.env[k]) ? 'agent' : 'text';
}

/** --base, else the pull request base on GitHub Actions. */
function resolveBase(flags: CheckFlags, io: CliIO): string | undefined {
  if (flags.base !== undefined) return flags.base;
  const pr = io.env['GITHUB_BASE_REF'];
  return pr ? `origin/${pr}` : undefined;
}

const FORMATS: readonly Format[] = ['text', 'json', 'sarif', 'markdown', 'agent'];

function useColor(format: Format, flags: CheckFlags, io: CliIO): boolean {
  if (format !== 'text' || flags.output !== undefined || !flags.color) return false;
  const force = io.env['FORCE_COLOR'];
  if (force !== undefined && force !== '' && force !== '0') return true;
  return io.isTTY && !io.env['NO_COLOR'];
}

const exceeds = (
  errors: number,
  warnings: number,
  failOn: 'error' | 'warning' | 'none',
): boolean => (failOn === 'none' ? false : failOn === 'error' ? errors > 0 : errors + warnings > 0);

/** Runs the CLI and returns the process exit code (0 clean, 1 findings, 2 usage or runtime error). */
export async function main(argv: string[], io: CliIO): Promise<number> {
  let code = 0;
  const onWarning = (message: string): void => io.stderr(`warning: ${message}\n`);
  const cli = new Command()
    .name('ctxtruth')
    .description('Catch drift between your code and the docs AI agents read.')
    .version(version())
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  cli
    .command('check')
    .description('Check Markdown docs against the repository')
    .argument('[paths...]', 'files or directories to check (default: all configured targets)')
    .addOption(
      new Option(
        '--format <format>',
        'output format (default: text, or agent when run by a coding agent)',
      ).choices(FORMATS),
    )
    .option('--base <ref>', 'git ref to compare with (default on GitHub Actions: the PR base)')
    .option('--changed-only', 'only check docs, or claims about code, changed since --base')
    .option('--new-only', 'only report findings introduced since --base')
    .option('--link-base <url>', 'URL prefix for file links in markdown output')
    .option('--output <file>', 'write the report to a file instead of stdout')
    .option('--sarif <file>', 'also write a SARIF report to this file')
    .option('--config <path>', 'config file (default: ctxtruth.config.* in the root)')
    .option('--root <dir>', 'repository root (default: current directory)')
    .option('--untrusted', 'never import code from the repository (JSON config only, no plugins)')
    .addOption(
      new Option(
        '--fail-on <level>',
        'lowest severity that fails the run (overrides config)',
      ).choices(['error', 'warning', 'none']),
    )
    .option('--verbose', 'also list claims that could not be verified')
    .option('--no-color', 'disable coloured output')
    .exitOverride()
    .action(async (paths: string[], flags: CheckFlags) => {
      const { check } = await import('./run.js');
      const { formatReport } = await import('./report/index.js');
      const root = resolve(io.cwd, flags.root ?? '.');
      const base = resolveBase(flags, io);
      const { report, config, descriptions } = await check({
        root,
        paths,
        cwd: io.cwd,
        ...(flags.config !== undefined && { configPath: resolve(io.cwd, flags.config) }),
        ...(base !== undefined && { base }),
        ...(flags.changedOnly && { changedOnly: true }),
        ...(flags.newOnly && { newOnly: true }),
        onWarning,
        ...(flags.untrusted && { untrusted: true }),
      });
      if (paths.length > 0 && report.files.length === 0) {
        // A typo in a CI path argument must not pass silently.
        io.stderr(`warning: no target documents matched ${paths.join(', ')}\n`);
      }
      const format = resolveFormat(flags, io);
      const opts = {
        color: useColor(format, flags, io),
        verbose: !!flags.verbose,
        descriptions,
        ...(flags.linkBase !== undefined && { linkBase: flags.linkBase }),
      };
      const out = formatReport(report, format, opts);
      if (flags.output === undefined) io.stdout(out);
      else writeFileSync(resolve(io.cwd, flags.output), out);
      if (flags.sarif !== undefined) {
        writeFileSync(resolve(io.cwd, flags.sarif), formatReport(report, 'sarif', opts));
      }
      const failOn: Severity | 'none' = flags.failOn ?? config.failOn;
      code = exceeds(report.summary.errors, report.summary.warnings, failOn) ? 1 : 0;
    });

  cli
    .command('blame')
    .description('Find the commit that made each stale claim false')
    .argument('[paths...]', 'files or directories to check (default: all configured targets)')
    .addOption(
      new Option(
        '--format <format>',
        'output format (default: text, or agent when run by a coding agent)',
      ).choices(['text', 'json', 'agent']),
    )
    .option('--config <path>', 'config file (default: ctxtruth.config.* in the root)')
    .option('--root <dir>', 'repository root (default: current directory)')
    .option('--untrusted', 'never import code from the repository (JSON config only, no plugins)')
    .exitOverride()
    .action(
      async (
        paths: string[],
        flags: { format?: Format; config?: string; root?: string; untrusted?: boolean },
      ) => {
        const { blame } = await import('./blame.js');
        const { formatBlame } = await import('./report/blame.js');
        const report = await blame({
          root: resolve(io.cwd, flags.root ?? '.'),
          paths,
          cwd: io.cwd,
          ...(flags.config !== undefined && { configPath: resolve(io.cwd, flags.config) }),
          onWarning,
          ...(flags.untrusted && { untrusted: true }),
        });
        const format = resolveFormat({ ...flags, color: false }, io);
        io.stdout(formatBlame(report, format === 'json' || format === 'agent' ? format : 'text'));
      },
    );

  cli
    .command('history')
    .description('Walk the git history and record when each doc claim went stale')
    .addOption(
      new Option('--format <format>', 'output format')
        .choices(['text', 'jsonl', 'json'])
        .default('text'),
    )
    .option('--output <file>', 'write the report to a file instead of stdout')
    .option(
      '--max-commits <n>',
      'walk only the most recent n commits (default: 100, unless --since is given)',
    )
    .option('--since <ref>', 'walk the commits after this ref (exclusive)')
    .option('--checks <ids>', 'comma-separated checks to run (default: all enabled but commands)')
    .option('--repo-name <name>', 'repository name in the output (default: the root folder name)')
    .option('--config <path>', 'config file (default: ctxtruth.config.* in the root)')
    .option('--root <dir>', 'repository root (default: current directory)')
    .option('--untrusted', 'never import code from the repository (JSON config only, no plugins)')
    .exitOverride()
    .action(
      async (flags: {
        format: HistoryFormat;
        output?: string;
        maxCommits?: string;
        since?: string;
        checks?: string;
        repoName?: string;
        config?: string;
        root?: string;
        untrusted?: boolean;
      }) => {
        const maxCommits = flags.maxCommits === undefined ? undefined : Number(flags.maxCommits);
        if (maxCommits !== undefined && (!Number.isInteger(maxCommits) || maxCommits < 1)) {
          throw new Error('--max-commits must be a positive integer');
        }
        const { history } = await import('./history.js');
        const { formatHistory } = await import('./report/history.js');
        const tty = process.stderr.isTTY;
        const result = await history({
          root: resolve(io.cwd, flags.root ?? '.'),
          ...(maxCommits !== undefined && { maxCommits }),
          ...(flags.untrusted && { untrusted: true }),
          ...(flags.config !== undefined && { configPath: resolve(io.cwd, flags.config) }),
          ...(flags.since !== undefined && { since: flags.since }),
          ...(flags.checks !== undefined && {
            checks: flags.checks
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          }),
          ...(flags.repoName !== undefined && { repoName: flags.repoName }),
          onWarning,
          ...(tty && {
            onProgress: (n: number, total: number) => io.stderr(`\r${n}/${total} commits`),
          }),
        });
        if (tty) io.stderr('\n');
        const out = formatHistory(result, flags.format);
        if (flags.output === undefined) io.stdout(out);
        else writeFileSync(resolve(io.cwd, flags.output), out);
      },
    );

  try {
    await cli.parseAsync(argv, { from: 'user' });
    return code;
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help and --version exit through commander with code 0; everything else is a usage error.
      return err.exitCode === 0 ? 0 : 2;
    }
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(realpathSync(entry)).href === import.meta.url) {
  main(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    cwd: process.cwd(),
    isTTY: process.stdout.isTTY,
    env: process.env,
  }).then((code) => {
    process.exitCode = code;
  });
}
