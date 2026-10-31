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
  Options and defaults:

  | Option                                                              | Default  |
  | ------------------------------------------------------------------- | -------- |
  | `routes`, `logger`                                                  | required |
  | `before` hooks, `readiness` checks, `closeHooks`, `metrics` handler | none     |
  | `bodyLimit`                                                         | 1 MiB    |
  | `readinessTimeoutMs` (for each check)                               | 2000     |
  | `drainDelayMs`                                                      | 5000     |
  | `shutdownTimeoutMs` (the full shutdown)                             | 19000    |

- Order of a request:

  ```
  /health, /ready, /metrics --> answered, no hooks
  other paths --> before hooks --> router (404, 405) --> handler
  ```

  So a caller that a hook rejects (for example 401) does not see which
  routes exist. A hook throws a `DomainError` to stop the request, or puts
  data in `request.state`. `request.params` is set after the hooks.

- Routes are method and path, with params: `/api/tasks/:taskId`. A param
  that does not decode, has `/` or `\`, or is `.` or `..` gives 400.
- `request.json()` reads the body once: 415 if it is not JSON, 413 above
  the limit, 400 for bad JSON. These answers have `connection: close`, the
  server stops reading the body, and the socket closes after the answer.
- `validate(request, { body, params, query })` checks with zod and gives 400
  with the issue paths, never the values.
- A reply is `{ status, headers, body }`. The body is JSON, unless the
  handler sets a non-JSON `content-type` and gives a string or bytes.
- Errors: `DomainError(code, status, message, headers?)` and
  `ValidationError` (400), `UnauthorizedError` (401), `ForbiddenError` (403),
  `NotFoundError` (404), `ConflictError` (409), `RateLimitedError` (429),
  `UnavailableError` (503). Each gives RFC 9457 problem JSON with a `code`,
  and sets its `headers` (for example `www-authenticate`, `retry-after`).
  Other errors give 500 with no detail, and go to the log with the method
  and path.
- `x-request-id` and `x-correlation-id` are used only if they are lower-case
  UUID v4 (ADR 0022); else the server makes a new one. The correlation id is
  the request id by default. Both are in the response and in `getContext()`
  through all async code.
- `/health` gives 200 while the process runs. `/ready` runs the readiness
  checks, each with a timeout, and gives 503 with the names of the failing
  checks (and `shutdown` during shutdown).
- Shutdown, from `close()` or from SIGTERM/SIGINT after `handleSignals()`:

  ```
  /ready gives 503, all answers get connection: close
  wait drainDelayMs (still accepting, so Traefik removes the pod)
  server.close(), close idle sockets, wait for in-flight requests
  close hooks in reverse order
  all of it inside shutdownTimeoutMs; at the deadline: close the sockets
  ```

  `close()` gives `true` if all of it ended in time with no hook error.
  `handleSignals()` then exits with 0, else with 1. Calling it twice has no
  effect.

## `./config`

- `loadConfig(schema, env = process.env)` gives a deep-frozen typed object.
  On a bad value it throws `ConfigError` with the variable names and the
  issues, never the values. A transform that throws gives the variable
  name only, with no `cause`.
- `commonEnv` is the schema of `SERVICE_NAME`, `PORT` (8080), `LOG_LEVEL`
  (info) and `RELEASE` (local). Extend it with `.extend({...})`.

## `./observability`

- `createLogger({ service, release, level })` gives a pino logger. It adds
  `requestId`, `correlationId` and `traceId`. Log objects and child
  bindings go through a censor at all depths, in arrays, errors and their
  `cause`. A key is redacted when, in lower case and with no `-` or `_`, it
  is one of: `authorization`, `proxyauthorization`, `cookie`, `setcookie`,
  `token`, `accesstoken`, `refreshtoken`, `idtoken`, `apikey`, `xapikey`,
  `password`, `secret`, `clientsecret`, `prompt`, `messages`.
- Limit: the censor looks at keys only. A secret inside a string (the log
  message, an error message) is not redacted. Do not put secrets or prompt
  text in strings.
- `startTelemetry({ serviceName, release, metricsPort })` starts the
  OpenTelemetry Node SDK with http and undici instrumentation and the env
  and service instance resource detectors only. Traces go over OTLP only
  when `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
  is set. Metrics are for Prometheus: on `/metrics` of the service (pass
  `telemetry.metricsHandler` to `createService`), or on `metricsPort`.
  `telemetry.counter()` and `telemetry.histogram()` make instruments.

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
