# ctxtruth

Catch drift between your code and the docs AI agents read.

<!-- ctxtruth-ignore -->

AI coding agents trust `AGENTS.md`, `CLAUDE.md`, Cursor rules, the README and `docs/` as ground truth.
Code moves on, the docs do not, and the agent confidently runs scripts that were deleted and edits files that were renamed.
`ctxtruth` checks every verifiable claim in those files against the repository and reports the ones that are no longer true.

## Status

Early development (v0.x). Milestone 1 checks are available: paths, scripts and commands.
Symbol, snippet and version checks, CI integrations and LLM-assisted checks are on the [roadmap](#roadmap).
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

## Example

This is the real output on the drift fixture used by the test suite, a small pnpm monorepo whose docs went stale:

```text
AGENTS.md  freshness 33% (3/9)
  6:31   error    Path `src/utils/format.ts` does not exist (did you mean `src/utils/formatting.ts`?)           paths
                  suggestion: src/utils/formatting.ts
  7:33   error    Path `src/old/config.ts` does not exist (moved to `src/config.ts`?)                           paths
                  suggestion: src/config.ts
  16:10  error    Script `typecheck` is not defined in `package.json`                                           scripts
  17:9   error    Script `buidl` is not defined in `package.json` (did you mean `build`?)                       scripts
                  suggestion: build
  18:6   warning  Script `dev` is not defined in `package.json` (it is defined in `packages/web/package.json`)  scripts
  19:1   warning  Command `tsx` is not installed as a dependency                                                commands

docs/guide.md  freshness 67% (2/3)
  5:24  error  Path `../src/old/config.ts` does not exist (moved to `src/config.ts`?)  paths
               suggestion: src/config.ts

✖ 5 errors, 2 warnings · 20 claims · 10 verified · 3 unknown · freshness 59% · 82 ms
```

Every finding has a position (`line:col`), a severity, the check that produced it and, when one is obvious, a concrete suggestion.
The exit code is 1 because there are errors; see [exit codes](#exit-codes).

## What it checks

| Check      | Status  | What it verifies                                                                          |
| ---------- | ------- | ----------------------------------------------------------------------------------------- |
| `paths`    | M1      | Files and directories mentioned in inline code and links exist. Suggests renames/moves.   |
| `scripts`  | M1      | Script names used with `npm`, `pnpm`, `yarn` and `bun` exist in the right `package.json`. |
| `commands` | M1      | Binaries used in shell fences are installed dependencies (system tools are skipped).      |
| `symbols`  | planned | Functions, classes and exports named in the docs still exist.                             |
| `snippets` | planned | Code blocks still match, or still compile against, the code they describe.                |
| `versions` | planned | Versions and engine requirements in the docs match the manifests.                         |

Monorepos are understood: a script is looked up in the nearest package, workspace filters are resolved, and a script that exists only in another workspace is reported with its location.

## How claims are extracted

`ctxtruth` parses Markdown properly rather than grepping it, and only treats something as a claim when it has a clear shape.

- **Inline code** that looks like a path (it has an extension or a slash) becomes a path claim. Inline `npm`, `pnpm`, `yarn`, `bun` and `npx` commands become script claims.
- **Links and images** with a relative target become path claims, resolved against the document's own directory first, then the repo root. URLs and anchors are ignored.
- **Shell fences** (`sh`, `bash`, `shell`, `zsh`, `console`) are split into commands. Package-manager invocations become script claims and the first binary of other commands becomes a command claim. Line continuations and `&&` chains are handled.
- **Plain prose** is only scanned when `prose` is enabled, because it is noisy.
- **Frontmatter** is skipped.

Some claims cannot be verified and are reported as `unknown`, not as failures. They are hidden by default and listed with `--verbose`:

- _Weak paths_ such as `react-dom/client` or `origin/main` have no extension, trailing slash or leading `./`, so they are often not paths at all. They are only checked when their first segment is a real directory.
- _Gitignored paths_ such as build output do not have to exist in a fresh checkout.
- _System binaries_ such as `git` or `curl` are not project dependencies.
- _Paths outside the repository_ cannot be checked.

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

| Option    | Default                         | Description                                                                  |
| --------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `targets` | agent and doc files (see below) | Glob patterns of Markdown files to check.                                    |
| `ignore`  | `[]`                            | Glob patterns excluded from `targets`.                                       |
| `rules`   | see below                       | Severity per check: `"error"`, `"warning"` or `"off"`.                       |
| `prose`   | `false`                         | Also extract path claims from plain prose.                                   |
| `failOn`  | `"error"`                       | Lowest severity that makes the run fail: `"error"`, `"warning"` or `"none"`. |

<!-- ctxtruth-ignore -->

Default `targets`: any `AGENTS.md` and `CLAUDE.md` (at any depth), Cursor rules (`.md` and `.mdc` files under the Cursor rules directory), the Copilot instructions file under the GitHub directory, the root README and everything in `docs/`.

Default `rules`: `paths` and `scripts` are `error`; `commands`, `symbols` and `versions` are `warning`; `snippets` is `error`. Checks that are not implemented yet are ignored.

### Ignoring claims in a document

```md
<!-- ctxtruth-ignore -->

The next block (paragraph, list, code fence) is not checked.

<!-- ctxtruth-disable -->

Everything between disable and enable is not checked.

<!-- ctxtruth-enable -->
```

## CLI reference

```text
ctxtruth check [paths...] [options]
```

| Option              | Description                                                                     |
| ------------------- | ------------------------------------------------------------------------------- |
| `paths...`          | Files or directories to check, relative to the current directory.               |
| `--format <format>` | `text` (default) or `json`. The JSON report has a versioned schema.             |
| `--config <path>`   | Use this config file instead of searching the root.                             |
| `--root <dir>`      | Repository root. Defaults to the current directory.                             |
| `--fail-on <level>` | `error`, `warning` or `none`. Overrides the config file.                        |
| `--verbose`         | Also list claims that were `unknown`, with the reason.                          |
| `--no-color`        | Disable colour. Colour is also off when not a TTY, with `NO_COLOR`, or in JSON. |

`FORCE_COLOR` (anything but `0`) forces colour on.

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

## Design principles

- **Deterministic first.** Every check in this release is plain static analysis: same repository, same result, no network.
- **Precision over recall.** A false alarm costs more trust than a missed one. Ambiguous claims are `unknown`, never findings.
- **LLMs only where they add value, and opt-in.** Planned: semantic checks for claims that cannot be verified mechanically, behind an explicit flag with cost tracking. Nothing in this release calls a model.
- **Read-only.** It never edits your files; suggestions are printed, not applied.
- **Honest numbers.** Every run reports how many claims were verified, failed or unknown, and a freshness score per file.

## Roadmap

- **M1 (current):** paths, scripts and commands checks, text and JSON reports, config.
- **M2:** symbols, snippets and versions checks.
- **M3:** GitHub Action, SARIF output, reporting only findings a pull request introduces, `--changed-only`.
- **M4:** history engine: `ctxtruth blame` to find the commit that made a claim stale, and the DriftBench dataset.
- **M5:** opt-in LLM checks with cost tracking, and evals to measure them.
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
