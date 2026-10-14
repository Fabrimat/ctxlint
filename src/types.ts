/**
 * Core data model shared by every module.
 *
 * Flow: parse (Markdown -> Claim[]) -> checks (Claim -> CheckResult) -> report.
 * Positions are 1-based and point at the claim text itself, not its Markdown node.
 */

export type ClaimKind = 'path' | 'script' | 'command' | 'symbol' | 'snippet' | 'version';

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

export type CheckId = 'paths' | 'scripts' | 'commands' | 'symbols' | 'snippets' | 'versions';

export interface Finding {
  file: string;
  line: number;
  col: number;
  checkId: CheckId;
  severity: Severity;
  message: string;
  /** Concrete replacement text when one is obvious (e.g. the renamed path). */
  suggestion?: string;
}

export type CheckStatus = 'pass' | 'fail' | 'unknown';

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
  run(claims: readonly Claim[], ctx: CheckContext): CheckResult[] | Promise<CheckResult[]>;
}

/* ---------- report (src/report/*) ---------- */

export interface FileReport {
  file: string;
  /** pass / (pass + fail); null when the file has no verifiable claims. */
  freshness: number | null;
  results: CheckResult[];
}

export interface Report {
  /** JSON schema version of this report shape. */
  version: 1;
  tool: { name: string; version: string };
  files: FileReport[];
  /** Every finding, sorted by file, line, col. */
  findings: Finding[];
  summary: {
    files: number;
    claims: number;
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

/** Stable identity of a result across commits: no line numbers, no message text. */
export function fingerprint(r: CheckResult): string {
  const { claim } = r;
  return [r.checkId, claim.file, claim.kind, claim.value, claim.section.join(' > ')].join('\u0000');
}
