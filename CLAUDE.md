# CLAUDE.md for ai-systems-kit

Rules for all ai-systems repos: `ai-systems-docs/CLAUDE.md`
(local: `../docs/CLAUDE.md`).

## Commands

| Command                    | Does                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `npm ci`                   | install from the lock file, then build `dist/`                |
| `npm run build`            | `tsc` (TypeScript 7) to `dist/`                               |
| `npm run check`            | `tsc --noEmit` (TypeScript 7)                                 |
| `npm run lint`             | ESLint (strict type-checked) and Prettier check               |
| `npm test`                 | `node --test` with the coverage gate: 90% lines, 85% branches |
| `npm run verify`           | check, lint and test                                          |
| `npm run test:integration` | `*.integration.ts` with Testcontainers (needs Docker)         |
| `npm run dev:up`           | local system from `compose.yaml` (README, "Local system")     |
| `npm run dev:e2e`          | end-to-end check against the local system                     |
| `npm run dev:down`         | stop the local system and delete its volumes                  |

## Layout

One folder for each subpath export in `src/`, with an `index.ts`. Tests are
`*.test.ts` next to the code. Add a new export to `exports` in
`package.json`.

Code that needs MongoDB or NATS is in `*.io.ts` files. The unit coverage
gate does not include them. The integration tests (`*.integration.ts`,
not in `dist/`) cover them. Keep logic that needs no container in other
files, with unit tests.

## Local system

`dev/mongo/` and `dev/nats/` are copies from gitops (`npm run dev:sync`).
Do not edit them by hand. Each `docker compose` command needs
`--env-file .env.local`. Run `npm run dev:down` when you are done.

## Integration tests

Each `*.integration.ts` file starts its own containers in `before` and
stops them in `after`. Wait for conditions with `waitFor`, never with a
fixed sleep. Close each relay and consumer, also when a test fails, else
the process does not stop. `messaging.integration.ts` runs with the
ADR 0023 grants of a test user `worker`.

The CI job `integration` runs on `ubuntu-22.04` (kernel 6.8). `mongo:8.0.34`
does not start on Linux 6.19 to 7.0.13 (MongoDB SERVER-121912, SERVER-125742),
and `ubuntu-24.04` has kernel 7.0.0. Move the job back to `ubuntu-24.04` when
its kernel is 7.0.14 or newer, or when gitops moves to a MongoDB version that
starts on it.

## TypeScript 6 and 7

`typescript-eslint` needs the TypeScript 6 API, and TypeScript 7 has no JS
API. So `typescript` is `@typescript/typescript6` (only for ESLint), and
`typescript-7` is TypeScript 7 (for `check` and `build`). The scripts call
`node_modules/typescript-7/bin/tsc` directly. Do not run `npx tsc`: it
gives TypeScript 6. The override `"@typescript/old":
"npm:typescript@6.0.3"` keeps TypeScript 6 inside the typescript-eslint
peer range. Decision: ADR 0022. Remove the aliases when `typescript-eslint`
supports TypeScript 7.

## skipLibCheck

`skipLibCheck` is on because the types of `thread-stream` (from pino) do
not compile with `@types/node` 26.

## Telemetry and ESM

ESM code does not call `require("node:http")`, so the OpenTelemetry hook
does not patch it. `startTelemetry` requires `node:http` and `node:https`
after `sdk.start()` and calls `syncBuiltinESMExports()`. Do not remove
this: without it the server spans and metrics stop. The test
`serves custom and http metrics` fails if it goes.
