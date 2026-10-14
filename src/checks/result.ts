import { posix } from 'node:path';
import type { CheckId, CheckResult, Claim, Severity } from '../types.js';

export function pass(claim: Claim, checkId: CheckId, resolvedFiles: string[]): CheckResult {
  return { claim, checkId, status: 'pass', resolvedFiles };
}

export function unknown(
  claim: Claim,
  checkId: CheckId,
  reason: string,
  resolvedFiles: string[] = [],
): CheckResult {
  return { claim, checkId, status: 'unknown', reason, resolvedFiles };
}

export function fail(
  claim: Claim,
  checkId: CheckId,
  severity: Severity,
  message: string,
  resolvedFiles: string[],
  suggestion?: string,
): CheckResult {
  return {
    claim,
    checkId,
    status: 'fail',
    finding: {
      file: claim.file,
      line: claim.line,
      col: claim.col,
      checkId,
      severity,
      message,
      ...(suggestion === undefined ? {} : { suggestion }),
    },
    resolvedFiles,
  };
}

/** Repo-relative POSIX dir of a doc file ('' for the root). */
export function docDir(file: string): string {
  const d = posix.dirname(file);
  return d === '.' ? '' : d;
}

export function packageJsonPath(dir: string): string {
  return dir ? `${dir}/package.json` : 'package.json';
}
