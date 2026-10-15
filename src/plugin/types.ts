/**
 * Public plugin API (apiVersion 1), exported from `ctxtruth/plugin` and `ctxtruth`.
 * See docs/plugins.md for the matcher semantics and the rules a plugin must follow.
 */
import type { Claim, RepoIndex } from '../types.js';

export interface CtxtruthPlugin {
  /** `/^[a-z0-9-]+$/`; every check id must be `${name}/<check>`. */
  name: string;
  /** Anything else is refused at load. */
  apiVersion: 1;
  checks: PluginCheck[];
  /** HTML comment pairs (regular expression sources) whose content is not checked. */
  ignoreRegions?: { begin: string; end: string }[];
}

export interface PluginCheck {
  /** `<plugin>/<check>`, `/^[a-z0-9-]+\/[a-z0-9-]+$/`. */
  id: string;
  /** SARIF shortDescription (falls back to the id). */
  description?: string;
  /** Overridden by config `rules[id]`; `off` there disables it (claims are still adopted). */
  defaultSeverity?: 'error' | 'warning';
  /**
   * The verdict depends on tools or state outside the checkout: at a past commit `verify` is not
   * called and every claim is unknown.
   */
  environment?: boolean;
  match: {
    /** Searched (`exec`) in the trimmed inline code; `g` and `y` flags are refused. */
    inlineCode?: RegExp;
    /** Searched in the link URL; `g` and `y` flags are refused. */
    links?: RegExp;
    /** Fence languages (case-insensitive); the whole block is one claim. */
    fences?: string[];
    /** Binaries adopted in shell fences and in inline code that starts with them. */
    commands?: string[];
  };
  /** Batch verification: one verdict per claim, in the same order. */
  verify(claims: readonly PluginClaim[], ctx: PluginContext): Verdict[] | Promise<Verdict[]>;
}

export type PluginClaim = Claim & {
  kind: 'custom';
  matched: 'inline-code' | 'link' | 'fence' | 'command';
  /** Commands: the words of `value`, split by the shell tokenizer. */
  argv?: string[];
  /** Fences: the lowercased language. */
  lang?: string;
  /** Regex capture groups (inlineCode and links); an unmatched group is ''. */
  groups?: string[];
};

export type Verdict =
  | { status: 'pass'; resolvedFiles?: string[] }
  | {
      status: 'fail';
      message: string;
      /** Replacement for the whole claim `value` (for a command: the full corrected command). */
      suggestion?: string;
      resolvedFiles?: string[];
    }
  | { status: 'unknown'; reason: string };

export type PluginIndex = Readonly<Pick<RepoIndex, 'files' | 'packages'>>;

export interface PluginContext {
  /** Absolute root of the checkout being checked (may be a temporary worktree of a past commit). */
  root: string;
  /** The checkout is a past commit (no installed dependencies, no build output). */
  pastCommit: boolean;
  /** Files and `package.json` packages of the checkout. Read-only: built-in checks share it. */
  index: PluginIndex;
  /** Reads a repo-relative file; undefined when missing. Throws on paths outside `root`. */
  readFile(path: string): Promise<string | undefined>;
  /** The plugin's options from config: `['pkg', { ... }]`. */
  options: unknown;
}

/** Identity helper that gives plugin modules type checking. */
export function definePlugin(plugin: CtxtruthPlugin): CtxtruthPlugin {
  return plugin;
}
