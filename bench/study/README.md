# Study: ctxtruth on 26 open-source TypeScript repositories

Every repository below has an `AGENTS.md` or `CLAUDE.md` at the listed commit. Each one was checked with the default configuration:

```sh
ctxtruth check --untrusted --format json
```

Clones were shallow, except zod, vitest and TanStack Query, which have full history and dependencies installed with `pnpm install --ignore-scripts`. Hooks were disabled, nothing else was installed, and no repository code ran. Every finding was checked by hand against the repository. No issue or pull request was opened on any of them.

## Totals

- 26 repositories, 796 documents, 14,052 claims: 10,945 verified, 3,097 unknown.
- 10 findings, all true positives (8 distinct problems), 0 false positives. This is an in-sample result: the precision rules were developed against these same repositories, and no held-out set has been run yet.
- 5,294 pages skipped by default: documentation sites (VitePress, Docusaurus, Nuxt Content, TanStack, Next.js, MDX) and historical records (ADRs, release notes), whose claims describe users' projects or past code. Agent files inside them are still checked.

Before the precision pass that produced these defaults, the same tool reported 7,555 findings on zod, vitest and TanStack Query alone, almost all of them false. The classes fixed are listed in the [CHANGELOG](../../CHANGELOG.md).

## Findings

| #    | Repository   | Where                                                               | What the doc says                                                                | What the repository has                                                      |
| ---- | ------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1    | langchainjs  | `AGENTS.md:48`                                                      | `@langchain/standard-tests` lives in `libs/langchain-standard-tests/`            | The package is at `internal/standard-tests/`                                 |
| 2    | langchainjs  | `AGENTS.md:124`                                                     | Lint rules are in `.oxlintrc.json`                                               | The file is `.oxlintrc.jsonc` (suggested)                                    |
| 3    | langchainjs  | `AGENTS.md:438`                                                     | `pnpm --filter @langchain/core lint:dpdm`                                        | `@langchain/core` has no `lint:dpdm` script; only provider packages do       |
| 4    | material-ui  | `AGENTS.md:258`                                                     | `pnpm vale <file1> <file2> ...`                                                  | No `vale` script or binary; the root scripts are `valelint` and `vale:fix`   |
| 5    | storybook    | `README.md:193`                                                     | `yarn lint:md` checks Markdown and code samples                                  | No package defines `lint:md`                                                 |
| 6    | prisma       | `docs/Testing Guide.md:557`                                         | imports `ResultType` and `Plan` from `@internal/sql-relational-core/types`       | That module exports neither (TS2305)                                         |
| 7    | prisma       | `docs/architecture docs/subsystems/3. Query Lanes.md:249`           | "the core `QueryAST`"                                                            | The class is `QueryAst`; a case-only difference, the weakest finding         |
| 8-10 | react-router | `docs/api/rsc/{createCallServer,getRSCStream,RSCHydratedRouter}.md` | import `unstable_createCallServer` / `unstable_getRSCStream` from `react-router` | Both are exported only from `react-router/dom` (one root cause, three pages) |

## Per repository

| repository                                                                                                                                  | commit    | docs checked | claims | verified | unknown | findings | skipped site/history pages |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -----------: | -----: | -------: | ------: | -------: | -------------------------: |
| [TanStack/router](https://github.com/TanStack/router/tree/7a0672503857283614799a0b480f4a82110e5ab6)                                         | `7a06725` |           15 |     83 |       75 |       8 |        0 |                        247 |
| [TanStack/table](https://github.com/TanStack/table/tree/95c4768496c07b45b1e65d8e33c3291ac66eae9b)                                           | `95c4768` |            2 |     10 |        5 |       5 |        0 |                       1262 |
| [anthropics/anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript/tree/04a4c28c70de498d6d0e930e43edb5edb9ac545e) | `04a4c28` |            2 |    143 |      133 |      10 |        0 |                          0 |
| [calcom/cal.com](https://github.com/calcom/cal.com/tree/54343aa685ae8f33159d2f485ec4a57bad5c574a)                                           | `54343aa` |            8 |    348 |      171 |     177 |        0 |                          0 |
| [elysiajs/elysia](https://github.com/elysiajs/elysia/tree/e037eca710e7ad193be09cc6615ab0dbe54af914)                                         | `e037eca` |            3 |      0 |        0 |       0 |        0 |                          0 |
| [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw/tree/4c37956ba5f04ec342a9d9d5891a38f22c5b7b4e)                             | `4c37956` |            4 |     19 |       16 |       3 |        0 |                          0 |
| [langchain-ai/langchainjs](https://github.com/langchain-ai/langchainjs/tree/bfa3b31fd3136495235984b43287b3c6eff7da3e)                       | `bfa3b31` |            3 |     60 |       49 |       8 |        3 |                          0 |
| [mastra-ai/mastra](https://github.com/mastra-ai/mastra/tree/a9de0d0bd8048819f203da297aa23d095f853b74)                                       | `a9de0d0` |           31 |    140 |      117 |      23 |        0 |                        114 |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk/tree/9bc40e903fde15534ec06ff4c1347d47000dbe16) | `9bc40e9` |            3 |     64 |       55 |       9 |        0 |                         48 |
| [mui/material-ui](https://github.com/mui/material-ui/tree/5c8382298543fed3cab4b398bac93d7e2add47eb)                                         | `5c83822` |            7 |    245 |      208 |      36 |        1 |                        332 |
| [n8n-io/n8n](https://github.com/n8n-io/n8n/tree/a94f5dc8b7a9d1ff41a742ec2efc19fcb4379159)                                                   | `a94f5dc` |          366 |   1827 |     1755 |      72 |        0 |                          1 |
| [nuxt/nuxt](https://github.com/nuxt/nuxt/tree/230a44767c329c69362242b8375faaac2800f8fa)                                                     | `230a447` |            2 |      0 |        0 |       0 |        0 |                        254 |
| [openai/openai-agents-js](https://github.com/openai/openai-agents-js/tree/9687b544c8c873080e6ff7e7d294c0b353cd9ab6)                         | `9687b54` |            3 |    117 |      110 |       7 |        0 |                          5 |
| [payloadcms/payload](https://github.com/payloadcms/payload/tree/73d3dd897381a851ff1708bbde19444d1a0c5b43)                                   | `73d3dd8` |            4 |    135 |      107 |      28 |        0 |                          0 |
| [prisma/prisma](https://github.com/prisma/prisma/tree/42fcd25bfa18e117264e1ec49b5621e9bf8e6b95)                                             | `42fcd25` |           93 |   7351 |     5519 |    1830 |        2 |                        232 |
| [remix-run/react-router](https://github.com/remix-run/react-router/tree/9da0ec9f3e68053d8deb6c6ee4a8d36f809f9335)                           | `9da0ec9` |          209 |   2614 |     1878 |     733 |        3 |                          0 |
| [storybookjs/storybook](https://github.com/storybookjs/storybook/tree/029657fb08db79466da879cdcf6ebc21dca097ee)                             | `029657f` |            5 |     79 |       65 |      13 |        1 |                        679 |
| [strapi/strapi](https://github.com/strapi/strapi/tree/5d80453d70115cf954416708e95ac7cdabf6479a)                                             | `5d80453` |            5 |    106 |       85 |      21 |        0 |                        142 |
| [supabase/supabase](https://github.com/supabase/supabase/tree/09a4374b14618659fea35395608bb70a414275b7)                                     | `09a4374` |           10 |    215 |      188 |      27 |        0 |                          0 |
| [sveltejs/svelte](https://github.com/sveltejs/svelte/tree/40bb08482f4857d91221638dec544a532bc35389)                                         | `40bb084` |            2 |      8 |        8 |       0 |        0 |                          0 |
| [unjs/nitro](https://github.com/unjs/nitro/tree/9d34a3c1ae5f798209d0b7c9f18a5c8e0cbe739d)                                                   | `9d34a3c` |            3 |    102 |       95 |       7 |        0 |                         94 |
| [vercel/ai](https://github.com/vercel/ai/tree/8a5233b15b1e69573d63faee6cd0014559252ee4)                                                     | `8a5233b` |            5 |    114 |       85 |      29 |        0 |                          0 |
| [withastro/astro](https://github.com/withastro/astro/tree/484822fbba652745c4f2da5ef434a350203578e2)                                         | `484822f` |            2 |     88 |       78 |      10 |        0 |                          0 |
| [colinhacks/zod](https://github.com/colinhacks/zod/tree/680d19f7d1e042e55934209caeb79bc843b94f44)                                           | `680d19f` |            3 |     45 |       24 |      21 |        0 |                          0 |
| [vitest-dev/vitest](https://github.com/vitest-dev/vitest/tree/3a8289ac382ff72e7c33345b4847d839e9c3d676)                                     | `3a8289a` |            4 |    136 |      116 |      20 |        0 |                        226 |
| [TanStack/query](https://github.com/TanStack/query/tree/ee47993724e5b71e65d9f38ae416367d2dd18395)                                           | `ee47993` |            2 |      3 |        3 |       0 |        0 |                       1658 |

## History

`ctxtruth history` over the last 100 (zod), 60 (vitest) and 40 (TanStack Query) first-parent commits recorded no stale episode: their agent docs were accurate at every commit walked.
