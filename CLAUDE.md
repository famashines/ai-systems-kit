# CLAUDE.md for ai-systems-kit

Rules for all ai-systems repos: `ai-systems-docs/CLAUDE.md`
(local: `../docs/CLAUDE.md`).

## Commands

| Command          | Does                                                          |
| ---------------- | ------------------------------------------------------------- |
| `npm ci`         | install from the lock file, then build `dist/`                |
| `npm run build`  | `tsc` (TypeScript 7) to `dist/`                               |
| `npm run check`  | `tsc --noEmit` (TypeScript 7)                                 |
| `npm run lint`   | ESLint (strict type-checked) and Prettier check               |
| `npm test`       | `node --test` with the coverage gate: 90% lines, 85% branches |
| `npm run verify` | check, lint and test                                          |

## Layout

One folder for each subpath export in `src/`, with an `index.ts`. Tests are
`*.test.ts` next to the code. Add a new export to `exports` in
`package.json`.

## TypeScript 6 and 7

`typescript-eslint` needs the TypeScript 6 API, and TypeScript 7 has no JS
API. So `typescript` is `@typescript/typescript6` (only for ESLint), and
`typescript-7` is TypeScript 7 (for `check` and `build`). The scripts call
`node_modules/typescript-7/bin/tsc` directly. Do not run `npx tsc`: it
gives TypeScript 6. Remove the alias when `typescript-eslint` supports
TypeScript 7.

## Telemetry and ESM

ESM code does not call `require("node:http")`, so the OpenTelemetry hook
does not patch it. `startTelemetry` requires `node:http` and `node:https`
after `sdk.start()` and calls `syncBuiltinESMExports()`. Do not remove
this: without it the server spans and metrics stop. The test
`serves custom and http metrics` fails if it goes.
