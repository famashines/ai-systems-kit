# Changelog

## 0.1.0

- `./mongo`: `connectMongo` with retry and a `ping` readiness check, and
  `runMigrations`.
- `./event-store`: `createEventStore` on MongoDB with expected version,
  command ids, `also` writes in the same transaction, positions,
  `readStream`, `readAll`, upcasters and `eventStoreMigration`.
- `./messaging`: `connectNats` with the service inbox prefix, the outbox
  relay, the durable consumer with idempotency, backoff and the DLQ,
  `processedMigration`, and rpc `request` and `serve`.
- `./testing`: in-memory event store, `fakeClock`, `fakeIds`, `waitFor`,
  `startMongo`, `startNats` and `createStreams`.
- `./http`: `ErrorCode` comes from `@famashines/ai-systems-contracts`.

- `./http`: before hooks run before routing. `DomainError` has `headers`.
  New codes `method_not_allowed`, `payload_too_large` and
  `unsupported_media_type`. Body errors close the connection. Readiness
  checks have a timeout. Shutdown has a drain delay and one deadline, and
  `close()` gives `true` or `false`. Ids must be lower-case UUID v4. Params
  that are paths give 400. Handlers can set a `content-type`. A
  `hookBudgetMs` (4 s) at the end of the shutdown is kept for close hooks.
- `./config`: deep freeze of plain objects and arrays only, and no value leaks from a throwing transform.
- `./observability`: a recursive key censor replaces the pino paths. URL
  credentials are redacted. Errors keep their class name in `type`. Fewer
  resource attributes. OTLP also with `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`.
- zod is a peer dependency. The TypeScript 7 alias is `typescript-7`
  (ADR 0022).

- `./http`: server on `node:http` with router, JSON body limit, zod
  validation, typed errors to problem JSON, request and correlation ids,
  before hooks, `/health`, `/ready`, `/metrics` and graceful shutdown.
- `./config`: `loadConfig` and `commonEnv`.
- `./observability`: `createLogger` with redaction and `startTelemetry`
  with OTLP traces and Prometheus metrics.
