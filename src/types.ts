/**
 * Core data model shared by every module.
 *
 * Flow: parse (Markdown -> Claim[]) -> checks (Claim -> CheckResult) -> report.
 * Positions are 1-based and point at the claim text itself, not its Markdown node.
 */

/**
 * `custom` claims are extracted for a plugin check, named in `meta.check`. `section` claims are a
 * whole Markdown section judged by a model (`--llm`).
 */
export type ClaimKind =
  'path' | 'script' | 'command' | 'symbol' | 'snippet' | 'version' | 'section' | 'custom';

/** Where in the Markdown the claim was found. Drives default severity: prose is opt-in. */
export type ClaimSource = 'inline-code' | 'link' | 'fence' | 'prose';

export interface Claim {
  kind: ClaimKind;
  /** Normalised claim text, e.g. `src/index.ts`, `build`, `UserService.find`. */
  value: string;
  /** Repo-relative POSIX path of the Markdown file. */
  file: string;
  line: number;
  col: number;
  /** Heading path of the enclosing section, e.g. `["Setup", "Scripts"]`. */
  section: string[];
  source: ClaimSource;
  /** Kind-specific extra data (e.g. package manager, workspace filter, fence language). */
  meta?: Record<string, string>;
}

export type Severity = 'error' | 'warning';
export type RuleLevel = Severity | 'off';

export type BuiltinCheckId =
  'paths' | 'scripts' | 'commands' | 'symbols' | 'snippets' | 'versions' | 'semantic';

/** A built-in check id, or a plugin check id namespaced as `<plugin>/<check>`. */
export type CheckId = string;

export interface Finding {
  file: string;
  line: number;
  col: number;
  checkId: CheckId;
  severity: Severity;
  message: string;
  /** Concrete replacement text when one is obvious (e.g. the renamed path). */
  suggestion?: string;
  /**
   * Set when the run is compared with a base ref: `docs` when the doc file changed since the base,
   * `code` when only the code did (the change made an unchanged claim false).
   */
  introducedBy?: 'docs' | 'code';
  /** The model that judged the claim; set on model-judged findings only. */
  model?: string;
  /** A proposed rewrite of the claim's lines (`--fix`); lines are 1-based and inclusive. */
  proposedFix?: { startLine: number; endLine: number; replacement: string };
}

export type CheckStatus = 'pass' | 'fail' | 'unknown';

/**
 * How a failing result relates to the base ref (only with `--new-only`): `new` failures are
 * reported, `existing` ones (already failing at the base) and `not-comparable` ones (unknown at
 * the base) are kept in the report but not shown or counted as findings.
 */
export type Baseline = 'new' | 'existing' | 'not-comparable';

export interface CheckResult {
  claim: Claim;
  checkId: CheckId;
  status: CheckStatus;
  /** Required when status is `unknown`: why the claim could not be verified. */
  reason?: string;
  /** Present when status is `fail`. */
  finding?: Finding;
  /** Repo-relative code files this claim depends on (used by --changed-only and LLM scoping). */
  resolvedFiles: string[];
  /** Set on failing results when the run is compared with a base ref. */
  baseline?: Baseline;
}

/* ---------- repo index (built by src/index) ---------- */

export interface FileIndex {
  /** Repo-relative POSIX paths of every tracked or untracked-but-not-ignored file. */
  files: readonly string[];
  hasFile(path: string): boolean;
  /** True for any directory that contains at least one indexed file. */
  hasDir(path: string): boolean;
  /** Indexed files whose basename equals `name` (used for "moved to" hints). */
  findByBasename(name: string): string[];
}

export interface PackageInfo {
  /** Repo-relative POSIX dir of the package ('' for the root package). */
  dir: string;
  name?: string;
  scripts: Record<string, string>;
  /** Union of dependencies, devDependencies, peerDependencies, optionalDependencies. */
  deps: Record<string, string>;
  /** Binary names available in `<dir>/node_modules/.bin`. */
  bins: string[];
}

export interface PackageIndex {
  root: PackageInfo;
  /** Root first, then workspaces in declaration order. */
  all: PackageInfo[];
}

export interface RepoIndex {
  /** Absolute path of the repo root. */
  root: string;
  files: FileIndex;
  packages: PackageIndex;
  /**
   * Absolute root whose `node_modules` serve TypeScript resolution. Set when checking a base
   * worktree, which has no installed dependencies of its own.
   */
  depsRoot?: string;
}

/* ---------- checks (src/checks/*) ---------- */

export interface CheckContext {
  index: RepoIndex;
  /** Configured severity for this check (never 'off': disabled checks are not run). */
  severity: Severity;
}

export interface Check {
  id: CheckId;
  /** Claim kinds this check consumes. */
  kinds: readonly ClaimKind[];
  /**
   * The verdict depends on tools or state outside the checkout (installed binaries, a CLI on
   * PATH): at a past commit it cannot be reproduced, so comparisons treat it as not comparable.
   */
  environment?: boolean;
  /** Plugin checks: the SARIF rule description. */
  description?: string;
  run(claims: readonly Claim[], ctx: CheckContext): CheckResult[] | Promise<CheckResult[]>;
}

/* ---------- report (src/report/*) ---------- */

export interface FileReport {
  file: string;
  /** pass / (pass + fail); null when the file has no verifiable claims. */
  freshness: number | null;
  results: CheckResult[];
}

/** Present when the run was compared with a base ref. */
export interface Comparison {
  /** The base ref as given (e.g. `origin/main`). */
  base: string;
  /** The commit the base ref resolved to (the merge base with HEAD). */
  baseSha: string;
  /** Failing results that are new since the base. */
  introduced: number;
  /** Failing results that already failed at the base. */
  existing: number;
  /** Results that failed at the base and pass now. */
  fixed: number;
  /** Failing results whose claim was unknown at the base. */
  notComparable: number;
}

/** What the model calls of a run cost and how many were not made. */
export interface LlmTotals {
  calls: number;
  failedCalls: number;
  /** Sections or calls not run: over budget, no key, too large. */
  skipped: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Null when a call used a model with no known price. */
  costUsd: number | null;
  /** True when part of `costUsd` is a worst-case estimate (a sent call reported no usage). */
  costEstimated: boolean;
  latencyMs: number;
  /** Null when unlimited. */
  budgetUsd: number | null;
  models: string[];
}

export interface Report {
  /** JSON schema version of this report shape. */
  version: 1;
  tool: { name: string; version: string };
  files: FileReport[];
  /** Every reported finding (failing results whose baseline is unset or `new`), sorted by file, line, col. */
  findings: Finding[];
  comparison?: Comparison;
  /** Present when the run used `--llm`. */
  llm?: LlmTotals;
  summary: {
    files: number;
    claims: number;
    /** Every count but `errors` and `warnings` leaves out the model-judged results. */
    pass: number;
    fail: number;
    unknown: number;
    errors: number;
    warnings: number;
    /** Aggregate pass / (pass + fail); null when nothing was verifiable. */
    freshness: number | null;
    durationMs: number;
  };
}

/**
 * Stable identity of a result across commits: no line numbers, no message text and no section
 * (a renamed heading must not make its claims look new). Line endings are normalised because a
 * checkout can convert them (core.autocrlf).
 */
export function fingerprint(r: CheckResult): string {
  const { claim } = r;
  return [r.checkId, claim.file, claim.kind, claim.value.replace(/\r\n?/g, '\n')].join('\u0000');
}
