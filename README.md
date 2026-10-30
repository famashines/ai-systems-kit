# ai-systems-kit

Shared server code of ai-systems. Each service installs it from a git tag.
Reasons and the dependency list: ADR 0003, 0004, 0017 and 0018 in
`ai-systems-docs`.

```
@famashines/ai-systems-kit
├── ./http           server on node:http, router, body, zod, problem JSON, ids, health, ready, shutdown
├── ./config         env vars checked with zod at start
└── ./observability  pino logger with redaction, OpenTelemetry traces and metrics
```

## Install

```sh
npm install github:famashines/ai-systems-kit#v0.1.0
```

npm builds `dist/` with the `prepare` script on install. npm 11 asks for
approval of that script: add the package to `allowScripts` in the service
`package.json`.

## `./http`

- `createService(options)` gives `{ server, listen, close, handleSignals }`.
  Options: `routes`, `logger`, `before` hooks, `readiness` checks,
  `closeHooks`, `metrics` handler, `bodyLimit` (default 1 MiB),
  `shutdownTimeoutMs` (default 15 s).
- Routes are method and path, with params: `/api/tasks/:taskId`. An unknown
  path gives 404, a known path with a wrong method gives 405 with `allow`.
- `request.json()` reads the body once: 415 if it is not JSON, 413 above
  the limit, 400 for bad JSON. `validate(request, { body, params, query })`
  checks with zod and gives 400 with the issue paths, never the values.
- Errors: `DomainError(code, status, message)` and `ValidationError` (400),
  `UnauthorizedError` (401), `ForbiddenError` (403), `NotFoundError` (404),
  `ConflictError` (409), `RateLimitedError` (429), `UnavailableError` (503).
  Each gives RFC 9457 problem JSON with a `code`. Other errors give 500 with
  no detail, and go to the log.
- `x-request-id` and `x-correlation-id` (default: the request id) are in the
  response and in `getContext()` through all async code.
- `before` hooks run in order before the handler. A hook throws a
  `DomainError` to stop the request, or puts data in `request.state`.
- `/health` gives 200 while the process runs. `/ready` runs the readiness
  checks and gives 503 with the names of the failing checks.
- `handleSignals()`: on SIGTERM or SIGINT the server stops accepting, `/ready`
  gives 503, in-flight requests finish (up to the timeout), close hooks run
  in reverse order, then the process exits. Tests call `close()`.

## `./config`

- `loadConfig(schema, env = process.env)` gives a frozen typed object. On a
  bad value it throws `ConfigError` with the variable names and the issues,
  never the values.
- `commonEnv` is the schema of `SERVICE_NAME`, `PORT` (8080), `LOG_LEVEL`
  (info) and `RELEASE` (local). Extend it with `.extend({...})`.

## `./observability`

- `createLogger({ service, release, level })` gives a pino logger. It adds
  `requestId`, `correlationId` and `traceId`. It redacts `authorization`,
  `cookie`, `set-cookie`, `token`, `accessToken`, `refreshToken`, `apiKey`,
  `password`, `secret`, `prompt` and `messages` down to four levels.
- `startTelemetry({ serviceName, release, metricsPort })` starts the
  OpenTelemetry Node SDK with http and undici instrumentation. Traces go
  over OTLP only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Metrics are for
  Prometheus: on `/metrics` of the service (pass `telemetry.metricsHandler`
  to `createService`), or on `metricsPort`. `telemetry.counter()` and
  `telemetry.histogram()` make instruments.

Call `startTelemetry` before `createService`.

## Example service

```ts
import { commonEnv, loadConfig } from "@famashines/ai-systems-kit/config";
import { createService } from "@famashines/ai-systems-kit/http";
import { createLogger, startTelemetry } from "@famashines/ai-systems-kit/observability";

const config = loadConfig(commonEnv);
const { SERVICE_NAME: service, RELEASE: release } = config;
const telemetry = startTelemetry({ serviceName: service, release });
const app = createService({
  logger: createLogger({ service, release, level: config.LOG_LEVEL }),
  metrics: telemetry.metricsHandler,
  closeHooks: [telemetry.shutdown],
  routes: [{ method: "GET", path: "/api/ping", handler: () => ({ body: { ok: true } }) }],
});
await app.listen(config.PORT);
app.handleSignals();
```

## Commands

See `CLAUDE.md`.
