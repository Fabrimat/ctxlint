# Plugins

A plugin adds checks for claims ctxtruth does not know about: the commands of your own CLI, values from a project config file, ids in a content index.
A plugin is an ES module whose default export is a plugin object, or a function that takes the options from the config and returns one.

<!-- ctxtruth-ignore -->

```json
{
  "plugins": ["ctxtruth-bedrock", ["./tools/ctxtruth-local.mjs", { "strict": true }]],
  "rules": { "bedrock/commands": "error", "local/ids": "off" }
}
```

Package names resolve from the analysed repository, as if a file at its root required them.
Paths starting with `.` resolve against the directory of the config file.
Plugins load in config order.

## API (apiVersion 1)

The types come from `ctxtruth/plugin` (also re-exported by `ctxtruth`), with a `definePlugin` identity helper:

<!-- ctxtruth-disable -->

```js
import { definePlugin } from 'ctxtruth/plugin';

export default (options) =>
  definePlugin({
    name: 'demo', // /^[a-z0-9-]+$/
    apiVersion: 1,
    checks: [
      {
        id: 'demo/cli', // `<plugin name>/<check>`
        description: 'Documented demo command does not exist', // SARIF rule description
        defaultSeverity: 'warning', // or 'error'; config `rules` overrides it
        match: { commands: ['demo'] },
        async verify(claims, ctx) {
          const known = await loadKnownCommands(ctx); // your code
          return claims.map((c) =>
            known.has(c.argv[1])
              ? { status: 'pass' }
              : { status: 'fail', message: `Unknown command \`${c.argv[1]}\`` },
          );
        },
      },
    ],
  });
```

<!-- ctxtruth-enable -->

`verify` gets every claim of its check in one batch and returns one verdict per claim, in the same order:

- `{ status: 'pass', resolvedFiles? }`: the claim holds. `resolvedFiles` lists the repo-relative files it depends on (used by `--changed-only`).
- `{ status: 'fail', message, suggestion?, resolvedFiles? }`: the claim is false.
- `{ status: 'unknown', reason }`: the claim cannot be verified. Unknown never becomes a finding.

Verdicts are validated. A `verify` that throws or rejects, returns the wrong number of verdicts, or returns an invalid verdict makes those claims unknown, with a reason naming the plugin.
A plugin cannot produce a failure through malformed output.

The context passed to `verify`:

- `root`: the absolute root of the checkout being checked. It may be a temporary worktree of a past commit (`--new-only`, `blame`, `history`).
- `pastCommit`: true when the checkout is a past commit, which has no installed dependencies or build output.
- `index`: the repository index (files and packages). Treat it as read-only.
- `readFile(path)`: reads a repo-relative file, or returns `undefined` when it is missing. It throws for paths outside `root`; that guards against mix-ups and is not a sandbox.
- `options`: the second element of the plugin's config entry.

A plugin may also declare `ignoreRegions` (begin and end regular expression sources for HTML comments), merged with the config's.

## Matchers

Every claim a plugin matches is a `custom` claim of the first matching check, in config order, and built-in extraction skips it.
A check turned `off` in `rules` still takes its claims; they are simply not checked.

- `inlineCode`: a regular expression searched in the trimmed inline code. The capture groups reach `verify` as `groups` (an unmatched group is `''`).
- `links`: a regular expression searched in a link, image or definition URL, with `groups` as above.
- `fences`: fence languages, compared case-insensitively. The whole block is one claim, with `lang`.
- `commands`: binary names. In shell fences, and in inline code that starts with the binary, the command becomes a claim whose value runs from the binary to the end of its `&&`, `||`, `;` or `|` segment, with its words in `argv`. Environment assignments, `sudo` and Windows suffixes such as `.cmd` are skipped first, as for built-in commands. An adopted binary is not also a built-in `commands` claim.

Regular expressions with the `g` or `y` flag are refused at load: they keep state between calls.
A finding's identity across commits is its check id, doc file, kind and claim value, so keep claim values stable.

## Environment checks

Set `environment: true` on a check whose verdict depends on anything outside the checkout: a CLI on `PATH`, installed tools, a network service.
At a past commit ctxtruth does not call `verify` for it and every claim is unknown, because the past environment cannot be reproduced.
In practice such a check never makes a `--new-only` finding new (it is not comparable), `blame` reports its findings as undetermined, and `history` records no episodes for it.

A check that reads only files of the checkout through `ctx.readFile` must not set it: it then works at past commits too.

## Rules for plugin authors

- Never execute anything from the analysed checkout: no scripts, binaries or modules from `ctx.root`. The checkout can be a past commit or an untrusted pull request. Running your own tool (from `PATH` or your package) is an `environment` check.
- Do not cache per-repository state at module level. One process checks the base and the head of a comparison, and each commit of `blame` and `history`, alternately with the same plugin instance. Key any cache by `ctx.root`, or keep it inside `verify`.
- Ship a `default` condition in your package `exports` (or a `main`): ctxtruth resolves plugin packages with `require.resolve`, which does not match an `import`-only condition.
- Check ids are `<plugin name>/<check>`; config `rules` keys use them.

## Trust

Loading a plugin runs its code with the rights of the ctxtruth process, as does a JavaScript or TypeScript config file.
Install plugins as you would any dev dependency.
With `--untrusted` ctxtruth loads no plugins at all.
