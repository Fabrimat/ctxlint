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

## Inputs

| Input               | Default          | Description                                                                           |
| ------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `version`           | `latest`         | npm version of ctxtruth to run.                                                       |
| `command`           | npx with version | Command that runs ctxtruth. Useful to run a local build.                              |
| `args`              |                  | Extra CLI arguments, split on whitespace.                                             |
| `paths`             |                  | Files or directories to check, split on whitespace. Empty checks the default targets. |
| `base`              | PR base branch   | Git ref to compare against.                                                           |
| `new-only`          | `true` on PRs    | Report only findings introduced since the merge base. Also on when `base` is set.     |
| `comment`           | `true`           | Create or update the pull request comment.                                            |
| `sarif`             | `false`          | Write SARIF and upload it with the CodeQL upload action, category `ctxtruth`.         |
| `fail-on`           | `error`          | `error`, `warning` or `none`.                                                         |
| `github-token`      | `github.token`   | Token used to write the comment.                                                      |
| `working-directory` | `.`              | Directory to run in.                                                                  |

## Outputs

| Output      | Description                                                       |
| ----------- | ----------------------------------------------------------------- |
| `exit-code` | `0` clean, `1` findings at or above `fail-on`, `2` runtime error. |
| `report`    | Path of the Markdown report.                                      |

## The pull request comment

The report starts with a hidden marker line.
The action looks for an existing comment containing it and edits that one, so a pull request never gets more than one.
If the run is clean and no comment exists yet, nothing is posted; if one exists it is updated to show the clean result.
The report is also added to the job summary.

## Fork pull requests

Pull requests from forks get a read-only token, so the comment and the SARIF upload cannot succeed.
The action turns both into warnings and still fails the job when the checks do: the exit code is applied at the end, after the comment and upload steps.
The report stays available in the job summary.

## SARIF

With `sarif: true` the action writes a SARIF file and uploads it so findings show up as code scanning alerts.
This needs `security-events: write` and, on private repositories, GitHub code security.
