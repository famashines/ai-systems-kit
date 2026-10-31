# Changelog

## 0.3.1

- Local system: `dev/nats/streams/VIEWS.json` synced from gitops
  (`max_consumers` 64, ADR 0025).
- Tests: the `./auth` test "a valid token gives the subject" compares `exp`
  with the value in the token, so it does not fail at a second boundary.
  The `observeGauge` test checks that the last value stays after the
  remove.

## 0.3.0

- `./nats`: `connectNats` with the service inbox prefix, `orderedStream`
  (stream head and JetStream ordered consumers, moved from socket-gateway)
  and `observeGauge`. No module in its import graph imports `mongodb`; a
  test loads it with `mongodb` blocked.
- `./messaging`: `connectNats` uses the `./nats` connection and adds
  `logger`, `request` and `serve`; its API does not change. The relay and
  consumer gauges use `observeGauge`.
- Local system: `compose.yaml` with MongoDB, NATS (gitops grants and
  streams), a local OIDC issuer and the four M1 services, `npm run
dev:up`, `dev:e2e`, `dev:down` and `dev:sync`, and the CI job `e2e`.

## 0.2.0

- `./auth`: `createJwtVerifier` checks Keycloak access tokens with `jose`
  (RS256 only, `iss`, `aud`, `azp`, `exp`, `nbf`, `iat`, `typ`, realm role) against
  the remote JWKS with cache, rotation and a refetch cooldown. 401, 403 and
  503 (JWKS not available) are `DomainError`s with `WWW-Authenticate`.
  `bearerHook` for `./http` and `subjectOf`.
- `./auth` review fixes: `azp` must be the audience. An optional `logger`
  gets a warn line when a JWKS fetch fails. After a failed fetch, no fetch
  for 5 seconds (cached keys still work, other tokens get 503). A refused
  request with a body gets `connection: close`, and the body is not read.
- `./messaging`: after a MongoDB or NATS outage, the consumer checks the
  processed marker again before the handler runs again. If another pod
  processed the event during the outage, the consumer acks it and the
  handler does not run.
- `mongodb` is an optional peer dependency, so the gateways do not install
  it.

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
- Review fixes: MongoDB or NATS outages and DLQ publish failures do not use
  deliveries (the consumer keeps the message and tries again); the option
  `ordered`; `serve` drops replies that are not in `allowReplyPrefixes`
  (ADR 0025); events above 900 KiB give `payload_too_large`; relay metrics
  `outbox_oldest_pending_seconds` and `outbox_publish_failures_total`;
  logs and DLQ headers use `describeError`; `mongodb` is a peer dependency;
  test images are pinned by digest.
- A handler error counts as a delivery unless a ping to MongoDB or NATS
  fails. New gauge `consumer_oldest_held_seconds`.

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
