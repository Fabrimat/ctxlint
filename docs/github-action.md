# GitHub Action

The repository ships a composite action that runs `ctxtruth` on pull requests, posts the report as a comment and can upload SARIF to code scanning.

## Usage

<!-- ctxtruth-ignore -->

```yaml
name: ctxtruth
on: pull_request

permissions:
  contents: read
  pull-requests: write
  security-events: write # only needed with `sarif: true`

jobs:
  ctxtruth:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the base comparison needs the full history
      - uses: Fabrimat/ctxtruth@main
```

On pull requests the action compares against `origin/<base branch>` and reports only the findings the pull request introduces.
On other events it checks everything.

## Comparing with the base

With `--new-only` ctxtruth checks the merge base of `--base` and `HEAD` in a temporary git worktree and reports only failures that are new.
A finding is marked as a code change when its claim passed at the base and its document did not change, so the pull request made an unchanged claim false.

- `fetch-depth: 0` is required: without the base history the run fails with exit code 2 instead of checking less.
- `--changed-only` only keeps claims in changed documents or about changed files. It is faster to read but trades recall; `--new-only` is the precise mode.
- Version claims at the base are read from the base npm, pnpm or yarn lockfile. Without one ctxtruth can read, version failures are not comparable and are not reported. Locally, a `node_modules` out of sync with the lockfile can also produce spurious version findings.

## Inputs

| Input               | Default                         | Description                                                                           |
| ------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| `version`           | `^0`                            | npm version or range of ctxtruth to run.                                              |
| `command`           | npm package, installed in temp  | Command that runs ctxtruth. Useful to run a local build.                              |
| `args`              |                                 | Extra CLI arguments, split on whitespace.                                             |
| `paths`             |                                 | Files or directories to check, split on whitespace. Empty checks the default targets. |
| `base`              | PR base branch                  | Git ref to compare against.                                                           |
| `new-only`          | `true` on PRs                   | Report only findings introduced since the merge base. Also on when `base` is set.     |
| `untrusted`         | `true` on `pull_request_target` | Pass `--untrusted`: ctxtruth imports no config or plugin code from the repository.    |
| `comment`           | `true`                          | Create or update the pull request comment.                                            |
| `sarif`             | `false`                         | Write SARIF and upload it with the CodeQL upload action, category `ctxtruth`.         |
| `fail-on`           | `error`                         | `error`, `warning` or `none`.                                                         |
| `github-token`      | `github.token`                  | Token used to write the comment.                                                      |
| `working-directory` | `.`                             | Directory to run in.                                                                  |

## Outputs

| Output      | Description                                                       |
| ----------- | ----------------------------------------------------------------- |
| `exit-code` | `0` clean, `1` findings at or above `fail-on`, `2` runtime error. |
| `report`    | Path of the Markdown report.                                      |

## The pull request comment

The report starts with a hidden marker line.
The action looks for an existing comment posted by a bot account that contains it and edits that one, so a pull request never gets more than one.
If the run is clean and no comment exists yet, nothing is posted; if one exists it is updated to show the clean result.
The report is also added to the job summary.

## Fork pull requests

Pull requests from forks get a read-only token, so the comment and the SARIF upload cannot succeed.
The action turns both into warnings and still fails the job when the checks do: the exit code is applied at the end, after the comment and upload steps.
The report stays available in the job summary.

## Untrusted code

On `pull_request` the workflow runs without secrets and with a read-only token for forks, so checking the pull request's code is safe, plugins included.
`pull_request_target` runs with secrets: if you check out the pull request head there, everything in it is untrusted.
For that event `untrusted` defaults to `true`, so ctxtruth reads only a JSON config and loads no plugins, and the default launch installs ctxtruth outside the checkout, so a repository `.npmrc` cannot redirect it.
`untrusted` covers ctxtruth only: a custom `command` (e.g. `node dist/cli.js`) runs whatever the checkout contains.
On `pull_request_target` the action posts no comment and sets no default `base`: it compares only when you pass `base`.

## Semantic drift (`--llm`)

Pass `--llm` through `args` and give the step the provider key:

<!-- ctxtruth-ignore -->

```yaml
- uses: Fabrimat/ctxtruth@main
  with:
    args: --llm --max-cost 0.50
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

On pull requests the action sets the base, so only sections about the changed code are judged.
Model-judged findings are listed apart from verified ones and say which model judged them.
Install the provider SDK (`@anthropic-ai/sdk` or `openai`) where ctxtruth runs; without it, or without a key, the run warns and the sections stay unknown.

On `pull_request_target`, `--llm` sends content the pull request controls (docs and code) to the provider with your key, and the comment shows model text derived from it.
With `untrusted` on, the repository's `llm` config block is ignored and the built-in defaults apply, so a pull request cannot raise the budget, change the prices or pick the models; only the action's `args` (`--max-cost`, `--llm-scope`) change them.

## SARIF

With `sarif: true` the action writes a SARIF file and uploads it so findings show up as code scanning alerts.
This needs `security-events: write` and, on private repositories, GitHub code security.
