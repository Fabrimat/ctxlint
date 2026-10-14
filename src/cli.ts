#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CommanderError, Command, Option } from 'commander';
import type { Severity } from './types.js';

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: string;
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
}

interface CheckFlags {
  format: 'text' | 'json';
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

function useColor(flags: CheckFlags, io: CliIO): boolean {
  if (flags.format === 'json' || !flags.color) return false;
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
      new Option('--format <format>', 'output format').choices(['text', 'json']).default('text'),
    )
    .option('--config <path>', 'config file (default: ctxtruth.config.* in the root)')
    .option('--root <dir>', 'repository root (default: current directory)')
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
      const { report, config } = await check({
        root,
        paths,
        cwd: io.cwd,
        ...(flags.config !== undefined && { configPath: resolve(io.cwd, flags.config) }),
      });
      if (paths.length > 0 && report.files.length === 0) {
        // A typo in a CI path argument must not pass silently.
        io.stderr(`warning: no target documents matched ${paths.join(', ')}\n`);
      }
      io.stdout(
        formatReport(report, flags.format, {
          color: useColor(flags, io),
          verbose: !!flags.verbose,
        }),
      );
      const failOn: Severity | 'none' = flags.failOn ?? config.failOn;
      code = exceeds(report.summary.errors, report.summary.warnings, failOn) ? 1 : 0;
    });

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
