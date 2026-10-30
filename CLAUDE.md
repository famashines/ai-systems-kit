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
`typescript7` is TypeScript 7 (for `check` and `build`). The scripts call
`node_modules/typescript7/bin/tsc` directly. Remove the alias when
`typescript-eslint` supports TypeScript 7.
