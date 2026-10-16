# ctxtruth

Catch drift between your code and the docs AI agents read.

<!-- ctxtruth-ignore -->

AI coding agents trust `AGENTS.md`, `CLAUDE.md`, Cursor rules, the README and `docs/` as ground truth.
Code moves on, the docs do not, and the agent confidently runs scripts that were deleted and edits files that were renamed.
`ctxtruth` checks every verifiable claim in those files against the repository and reports the ones that are no longer true.

## Status

Early development (v0.x). Six deterministic checks are available: paths, scripts, commands, symbols, snippets and versions.
An opt-in, model-judged semantic check (`--llm`) covers what static analysis cannot verify.
The output format and configuration may still change before 1.0.

## Install and quick start

Run it without installing:

```sh
npx ctxtruth check
```

Or add it to a project:

```sh
pnpm add -D ctxtruth
pnpm exec ctxtruth check
```

It needs Node.js 22.18 or later and reads the repository in the current directory (or `--root`).
Inside a git repository it only looks at files git knows about, so ignored build output is never scanned.
It never writes files.

### GitHub Action

Run it on every pull request, with a comment that reports only the drift the pull request introduces:

<!-- ctxtruth-ignore -->

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: Fabrimat/ctxtruth@main
```

See the [GitHub Action guide](docs/github-action.md) for permissions, inputs and SARIF upload.

## Example

This is the real output on the drift fixture used by the test suite, a small pnpm monorepo whose docs went stale:

```text
AGENTS.md  freshness 23% (3/13)
  6:31   error    Path `src/utils/format.ts` does not exist (did you mean `src/utils/formatting.ts`?)           paths
                  suggestion: src/utils/formatting.ts
  7:33   error    Path `src/old/config.ts` does not exist (moved to `src/config.ts`?)                           paths
                  suggestion: src/config.ts
  16:10  error    Script `typecheck` is not defined in `package.json`                                           scripts
  17:9   error    Script `buidl` is not defined in `package.json` (did you mean `build`?)                       scripts
                  suggestion: build
  18:6   warning  Script `dev` is not defined in `package.json` (it is defined in `packages/web/package.json`)  scripts
  19:1   warning  Command `tsx` is not installed as a dependency                                                commands
  31:31  warning  Symbol `formatTimeStamp` is not defined in the codebase (did you mean `formatTimestamp`?)     symbols
                  suggestion: formatTimestamp
  32:9   warning  `Config` has no member `reload`                                                               symbols
  33:28  warning  Docs say `zod@3` but `package.json` requires `^4.1.0`                                         versions
                  suggestion: zod@4
  38:29  error    Snippet does not type-check: Expected 1 arguments, but got 2. (TS2554)                        snippets

docs/guide.md  freshness 67% (2/3)
  5:24  error  Path `../src/old/config.ts` does not exist (moved to `src/config.ts`?)  paths
               suggestion: src/config.ts

✖ 6 errors, 5 warnings · 24 claims · 10 verified · 3 unknown · freshness 48% · 698 ms
```

Every finding has a position (`line:col`), a severity, the check that produced it and, when one is obvious, a concrete suggestion.
The exit code is 1 because there are errors; see [exit codes](#exit-codes).

## What it checks

| Check      | Status | What it verifies                                                                          |
| ---------- | ------ | ----------------------------------------------------------------------------------------- |
| `paths`    | M1     | Files and directories mentioned in inline code and links exist. Suggests renames/moves.   |
| `scripts`  | M1     | Script names used with `npm`, `pnpm`, `yarn` and `bun` exist in the right `package.json`. |
| `commands` | M1     | Binaries used in shell fences are installed dependencies (system tools are skipped).      |
| `symbols`  | M2     | Functions, classes and members named in inline code exist. Suggests renamed symbols.      |
| `snippets` | M2     | `ts`/`tsx` code blocks still type-check against the code they import.                     |
| `versions` | M2     | `pkg@version` mentions match the installed version, the lockfile or `package.json`.       |

Plugins add checks for claims ctxtruth does not know about, such as your own CLI's commands or ids from a content index: see [docs/plugins.md](docs/plugins.md).

Monorepos are understood: a script is looked up in the nearest package, workspace filters are resolved, and a script that exists only in another workspace is reported with its location.

## How claims are extracted

`ctxtruth` parses Markdown properly rather than grepping it, and only treats something as a claim when it has a clear shape.

- **Inline code** that looks like a path (it has an extension or a slash) becomes a path claim. Inline `npm`, `pnpm`, `yarn`, `bun` and `npx` commands become script claims.
- **Links and images** with a relative target become path claims, resolved against the document's own directory first, then the repo root. URLs and anchors are ignored.
- **Shell fences** (`sh`, `bash`, `shell`, `zsh`, `console`) are split into commands. Package-manager invocations become script claims and the first binary of other commands becomes a command claim. Line continuations and `&&` chains are handled.
- **Inline code** shaped like a symbol (`createUser()`, `UserService.find`, `new Client()`, or a camelCase/PascalCase name) becomes a symbol claim; `zod@4`-style mentions and `pnpm add pkg@range` arguments become version claims.
- **TypeScript fences** (`ts`, `typescript`, `tsx`, `mts`, `cts`) become snippet claims. Add `ignore` to the fence info (` ```ts ignore `) or a `ctxtruth-ignore` comment to skip pseudo-code.
- **Plain prose** is only scanned when `prose` is enabled, because it is noisy.
- **Frontmatter** is skipped.

Some claims cannot be verified and are reported as `unknown`, not as failures. They are hidden by default and listed with `--verbose`:

- _Weak paths_ such as `react-dom/client` or `origin/main` have no extension, trailing slash or leading `./`, so they are often not paths at all. They are only checked when their first segment is a real directory.
- _Gitignored paths_ such as build output do not have to exist in a fresh checkout.
- _System binaries_ such as `git` or `curl` are not project dependencies.
- _Paths outside the repository_ cannot be checked.
- _Symbols that are not in the repository_ (globals, imports from packages, framework hooks) cannot be told apart from deleted ones, so a missing symbol is only reported when there is evidence of a rename: a close match in the codebase. A missing member of a class or object the repository defines is always reported.
- _Snippets_ only fail on a small set of type errors that mean drift: a missing export, property or module, or a wrong argument count or type. Undeclared variables and other partial-snippet noise are ignored, and code that does not parse is `unknown`.
- _Versions_ of packages no `package.json` declares are not checked.

Precision comes first: when in doubt, a claim is `unknown`, never a finding.

## Configuration

Put a `ctxtruth.config.json` (or `.ts`, `.mts`, `.mjs`, `.js`) in the repository root.
TypeScript configs get type checking through `defineConfig`:

```ts
import { defineConfig } from 'ctxtruth';

export default defineConfig({
  ignore: ['docs/archive/**'],
  rules: { commands: 'off' },
  failOn: 'warning',
});
```

All options and their defaults:

| Option          | Default                         | Description                                                                                 |
| --------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| `targets`       | agent and doc files (see below) | Glob patterns of Markdown files to check.                                                   |
| `ignore`        | `[]`                            | Glob patterns excluded from `targets`.                                                      |
| `rules`         | see below                       | Severity per check: `"error"`, `"warning"` or `"off"`; plugin checks as `<plugin>/<check>`. |
| `plugins`       | `[]`                            | Plugin packages or paths, optionally `["name", options]` ([plugins](docs/plugins.md)).      |
| `prose`         | `false`                         | Also extract path claims from plain prose.                                                  |
| `failOn`        | `"error"`                       | Lowest severity that makes the run fail: `"error"`, `"warning"` or `"none"`.                |
| `ignoreRegions` | `[]`                            | `{ begin, end }` regex sources; claims between matching HTML comments are skipped.          |

<!-- ctxtruth-ignore -->

Default `targets`: any `AGENTS.md` and `CLAUDE.md` (at any depth), Cursor rules (`.md` and `.mdc` files under the Cursor rules directory), the Copilot instructions file under the GitHub directory, the root README and everything in `docs/`.

Default `rules`: `paths` and `scripts` are `error`; `commands`, `symbols` and `versions` are `warning`; `snippets` is `error`.

### Ignoring claims in a document

```md
<!-- ctxtruth-ignore -->

The next block (paragraph, list, code fence) is not checked.

<!-- ctxtruth-disable -->

Everything between disable and enable is not checked.

<!-- ctxtruth-enable -->
```

Generated sections can be skipped with `ignoreRegions`: each HTML comment matching a `begin` regex opens a region and one matching `end` closes it (nesting is counted, an unclosed region runs to the end of the file). For example `{ "begin": "^<!-- BEGIN GENERATED", "end": "^<!-- END GENERATED" }`.

## CLI reference

```text
ctxtruth check [paths...] [options]
```

| Option              | Description                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `paths...`          | Files or directories to check, relative to the current directory.                                                                                                                    |
| `--format <format>` | `text`, `json`, `sarif`, `markdown` or `agent`. Default `text`, or `agent` when a coding agent runs it.                                                                              |
| `--base <ref>`      | Git ref to compare with. Defaults to the pull request base on GitHub Actions.                                                                                                        |
| `--new-only`        | Only report findings introduced since the merge base with `--base`.                                                                                                                  |
| `--changed-only`    | Only check claims in docs, or about files, changed since `--base` (trades recall).                                                                                                   |
| `--output <file>`   | Write the report to a file instead of stdout.                                                                                                                                        |
| `--sarif <file>`    | Also write a SARIF report to this file.                                                                                                                                              |
| `--link-base <url>` | URL prefix for file links in the markdown report.                                                                                                                                    |
| `--config <path>`   | Use this config file instead of searching the root.                                                                                                                                  |
| `--root <dir>`      | Repository root. Defaults to the current directory.                                                                                                                                  |
| `--fail-on <level>` | `error`, `warning` or `none`. Overrides the config file.                                                                                                                             |
| `--untrusted`       | Never import code from the repository: a `ctxtruth.config.{ts,mts,mjs,js}` is skipped (an explicit one is an error) and config `plugins` are ignored. Also on `blame` and `history`. |
| `--verbose`         | Also list claims that were `unknown`, with the reason.                                                                                                                               |
| `--no-color`        | Disable colour. Colour is also off when not a TTY, with `NO_COLOR`, or in JSON.                                                                                                      |
| `--llm`             | Also run the model-judged semantic check (see [Semantic drift](#semantic-drift-opt-in)).                                                                                             |
| `--llm-scope <s>`   | `changed` (default: sections about code changed since `--base`) or `all`.                                                                                                            |
| `--max-cost <usd>`  | Budget for model calls, or `unlimited`. Default `1.00`; calls that could exceed it are skipped.                                                                                      |
| `--fix`             | Ask a model for a proposed edit to each semantic finding (implies `--llm`). Nothing is written to the docs.                                                                          |
| `--patch <file>`    | Write the proposed edits as a unified diff, validated with `git apply --check` (implies `--fix`).                                                                                    |
| `--llm-dump <dir>`  | Debugging: write every prompt and response to this directory. Off by default.                                                                                                        |

`FORCE_COLOR` (anything but `0`) forces colour on.

### `ctxtruth blame`

```text
ctxtruth blame [paths...] [--format text|json|agent] [--config <path>] [--root <dir>]
```

For every claim `check` reports, finds the commit that made it false: it evaluates today's claim against the code at past commits of the first-parent history (one temporary worktree, binary search shared across claims). Each claim gets one cause:

| Cause                | Meaning                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `broken-by`          | The first commit where the claim became false, with renames or deletions of the files it relied on.  |
| `stale-when-written` | The claim was already false in the commit that wrote the doc line.                                   |
| `uncommitted`        | The claim holds at the HEAD commit; uncommitted changes break it.                                    |
| `undetermined`       | The check cannot verify the claim at past commits (e.g. installed versions), so no cause is guessed. |

```text
$ ctxtruth blame --format agent
ctxtruth blame: 1 stale claim. Each line names the commit that made the claim false; inspect it with `git show <sha>`.
CLAUDE.md:6:13 [paths] `src/utils/formatting.ts` broken by 4f01c11 (2026-10-15, "refactor: rename formatting") — renamed to `src/utils/text.ts` there
```

Past commits are checked with today's installed dependencies, so snippet and symbol blame can shift around dependency major upgrades. A doc line written on a side branch is checked against that branch's tree. Needs the full git history (`fetch-depth: 0` on GitHub Actions). Exit code 0, or 2 on errors.

### `ctxtruth history`

```text
ctxtruth history [--max-commits <n>] [--since <ref>] [--checks <ids>] [--format text|jsonl|json] [--output <file>]
```

Walks the last `n` first-parent commits (default 100) or those after `--since`, checks every commit's docs against that commit's code, and records **stale episodes**: when a claim became false, whether a code change or a doc edit caused it, and when and how it was resolved. The text format summarises them (open episodes, cause split, median days open); `jsonl` emits one episode per line. The `commands` check is skipped because past commits have no installed binaries. This is the engine behind [DriftBench](bench/driftbench/README.md).

### Exit codes

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| 0    | No findings at or above the `--fail-on` level.             |
| 1    | At least one finding at or above the `--fail-on` level.    |
| 2    | Usage, configuration or runtime error (message on stderr). |

### Programmatic use

```ts
import { check, formatReport } from 'ctxtruth';

const { report } = await check({ root: process.cwd() });
console.log(formatReport(report, 'text', { color: false, verbose: false }));
```

### Semantic drift (opt-in)

`--llm` asks a model whether a doc section still describes the code it refers to. Only sections whose claims resolve to code changed since `--base` are sent (or every linked section with `--llm-scope all`), together with those files and their diff; nothing is truncated silently, and oversized input is reported as `unknown`.

- **Providers:** Anthropic (default: `claude-haiku-5-5` to judge, `claude-opus-5-5` for `--fix`) or OpenAI, set in the `llm` config block. Install `@anthropic-ai/sdk` or `openai`; keys come only from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, never from config. Without a key every selected section is `unknown` and the exit code is unaffected.
- **Cost:** every report shows calls, tokens, cost and latency. Before each call the worst case is reserved against `--max-cost`; a call that could exceed it is skipped.
- **Labelled as such:** findings are marked model-judged and kept apart from verified ones in every format. The quoted sentence must exist in the section, model text is sanitised, and proposed edits must stay inside the section without adding links, headings, HTML or code blocks.
- **Never applied:** `--fix` only proposes; `--patch` writes a diff file you review and apply yourself.

## Machine-readable output

`check --format json`, `blame --format json` and `history --format json|jsonl` follow the JSON Schemas in [`schema/`](schema) (shipped in the npm package, also exported as zod schemas: `reportSchema`, `blameSchema`, `historySchema`, `historyEpisodeSchema`).

- Within a major version (`version: 1`) changes are additive only: new optional fields, new check ids (plugins add `<plugin>/<check>`), new claim kinds. Consumers must ignore unknown fields, so `checkId` and `kind` are plain strings.
- Removing, renaming or retyping a field bumps `version` to 2 and adds a `-v2.json` file; the v1 file stays.
- History episodes carry `v` instead of `version`, for historical reasons.
- The published schemas allow additional properties, because consumers should tolerate new fields; ctxtruth's own tests use the strict zod versions, so an undocumented field fails the build.

## Design principles

- **Deterministic first.** The six built-in checks are plain static analysis: same repository, same result, no network.
- **Precision over recall.** A false alarm costs more trust than a missed one. Ambiguous claims are `unknown`, never findings.
- **LLMs only where they add value, and opt-in.** The semantic check runs only with `--llm`, only on sections about changed code, within a budget, and its findings are labelled as model-judged. Invalid model output is `unknown`, never a pass.
- **Read-only.** It never edits your files; suggestions are printed, not applied.
- **Honest numbers.** Every run reports how many claims were verified, failed or unknown, and a freshness score per file.

## Evals

The semantic check is measured by an adversarial set of cases (`evals/`, see [evals/README.md](evals/README.md)). Precision and the false-positive rate on adversarial cases matter most.

| model | precision | recall | unsure | FPR (adv) | flip | $/check | p50 | n   |
| ----- | --------- | ------ | ------ | --------- | ---- | ------- | --- | --- |
|       |           |        |        |           |      |         |     |     |

Not run yet: the paid run needs approval.

## Roadmap

- **M1 (done):** paths, scripts and commands checks, text and JSON reports, config.
- **M2 (done):** symbols, snippets and versions checks.
- **M3 (done):** GitHub Action, SARIF output, reporting only findings a pull request introduces, `--changed-only`.
- **M4 (done):** history engine: `ctxtruth blame` to find the commit that made a claim stale, `ctxtruth history`, and the DriftBench dataset.
- **M4.5 (done):** plugin API for custom checks, `--untrusted`, `ignoreRegions`, and versioned JSON Schemas.
- **M5 (current):** opt-in semantic drift check (`--llm`) with cost tracking and a budget, proposed fixes as patches, and evals to measure it.
- **M6:** a study of documentation drift on real repositories.

## Contributing

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
node dist/cli.js check
```

The last command runs `ctxtruth` on its own docs; it must stay clean.

## License

[MIT](LICENSE)
