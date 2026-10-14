# Agent guide

## Layout

- The entry point is `src/index.ts`.
- Formatting helpers live in `src/utils/format.ts`.
- Configuration is loaded from `src/old/config.ts`.
- Build output goes to `dist/`.
- The UI imports `react-dom/client`.

## Commands

```sh
pnpm run build
pnpm test
pnpm run typecheck
npm run buidl
pnpm dev
tsx scripts/seed.ts
git status
```

## History

<!-- ctxtruth-ignore -->

The runner at `src/legacy/runner.ts` was removed in v1.
