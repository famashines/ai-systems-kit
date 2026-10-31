# ai-systems-kit

Shared server code of ai-systems. Each service installs it from a git tag.
Reasons and the dependency list: ADR 0003, 0004, 0017 and 0018 in
`ai-systems-docs`.

```
@famashines/ai-systems-kit
├── ./http           server on node:http, router, body, zod, problem JSON, ids, health, ready, shutdown
├── ./auth           JWT check of Keycloak access tokens with jose, bearer hook for ./http
├── ./config         env vars checked with zod at start
├── ./observability  pino logger with redaction, OpenTelemetry traces and metrics
├── ./mongo          MongoDB connect with retry, ping readiness, migrations
├── ./event-store    events on MongoDB: append with expected version, command ids, upcasters, replay
├── ./messaging      NATS connect, outbox relay, durable consumer with DLQ, rpc request and serve
└── ./testing        in-memory event store, fake clock and ids, waitFor, Testcontainers helpers
```

## Install

```sh
npm install github:famashines/ai-systems-kit#v0.2.0
```

npm builds `dist/` with the `prepare` script on install. npm 11 asks for
approval of install scripts. A service needs these `allowScripts` entries
in its `package.json` (`npm install-scripts approve <package>` writes the
first two with the commit of the tag):

```json
"allowScripts": {
  "github:famashines/ai-systems-kit#<commit of the kit tag>": true,
  "github:famashines/ai-systems-contracts#09f6c8c5385e90dd96cdc81fbd5c8c44d7e92257": true,
  "protobufjs": false
}
```

`protobufjs` (from OpenTelemetry) needs no install script. A service that
installs `testcontainers` also adds `"ssh2": false` and
`"cpu-features": false` (optional native parts that the tests do not use).

The kit installs `@famashines/ai-systems-contracts` (v0.1.0),
`@nats-io/transport-node`, `@nats-io/jetstream` and `jose`. Peer dependencies: a
service installs `mongodb` (7.8.0) and `zod` (4.6.7) itself, so that it and
the kit use one copy (two copies break the `Db` and `ClientSession` types
and `instanceof MongoServerError`). `mongodb` is an optional peer
dependency: a service with no database (the gateways) does not install it
and does not import `./mongo`, `./event-store` or `./messaging`.
`testcontainers` is an optional peer dependency: install it as a dev
dependency when you use `startMongo` or `startNats`.

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
  | `hookBudgetMs` (the end part, kept for close hooks)                 | 4000     |

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
    until shutdownTimeoutMs - hookBudgetMs, then close the open sockets
  close hooks one after the other, in reverse order, until shutdownTimeoutMs
  ```

  `close()` gives `true` if all of it ended in time with no hook error.
  `handleSignals()` then exits with 0, else with 1. Calling it twice has no
  effect.

- `close()` also waits `drainDelayMs` (5 s by default). Tests pass
  `drainDelayMs: 0`.

## `./auth`

The JWT check of ADR 0009 and ADR 0021, for both gateways.

```ts
import { bearerHook, createJwtVerifier, subjectOf } from "@famashines/ai-systems-kit/auth";

const verify = createJwtVerifier({
  issuer: "https://auth.famashines.com/realms/ai-systems",
  audience: "ai-systems-app",
  requiredRole: "owner",
});
const app = createService({ before: [bearerHook(verify)], routes, logger });
const handler: Handler = (request) => ({ body: { sub: subjectOf(request).sub } });
const subject = await verify(token);
```

- `createJwtVerifier({ issuer, audience, requiredRole, jwksUrl?, clockToleranceSec?, logger? })`
  gives `verify(token)`, which gives the subject `{ sub, roles, exp }`.
  `jwksUrl` is `<issuer>/protocol/openid-connect/certs` by default.
  `clockToleranceSec` is 30 by default. `logger` (pino) gets a warn line
  with the error and the JWKS URL when a JWKS fetch fails.
- `verify` does not need HTTP. socket-gateway calls it with the token of
  `hello`.
- The checks:

  | Check                                                          | Failure |
  | -------------------------------------------------------------- | ------- |
  | token length at most 8192                                      | 401     |
  | `alg` is `RS256` (no `none`, no HMAC, no other algorithm)      | 401     |
  | signature with a key of the JWKS, by `kid`                     | 401     |
  | `iss` is the issuer                                            | 401     |
  | `aud` is the audience or an array that has it                  | 401     |
  | `exp` and `nbf` (with the tolerance)                           | 401     |
  | `sub`, `exp` and `iat` are present; `iat` is not in the future | 401     |
  | `typ` is `Bearer` (a Keycloak access token, not an ID token)   | 401     |
  | `azp` is the audience (the token is for this client)           | 401     |
  | `realm_access.roles` has the role                              | 403     |
  | the JWKS cannot be read (error, timeout, bad answer)           | 503     |

- 401 is `UnauthorizedError` with
  `WWW-Authenticate: Bearer realm="ai-systems", error="invalid_token"`.
  403 is `ForbiddenError` with `error="insufficient_scope"`. 503 is
  `UnavailableError`: a Keycloak outage is not a bad token, so the app
  does not sign out.
- The JWKS (jose `createRemoteJWKSet`) is kept for 10 minutes. A token with
  an unknown `kid` causes one new fetch, but at most one fetch each 30
  seconds after a fetch that worked. So a key rotation in Keycloak works
  with no restart, and tokens with random `kid` values cannot flood
  Keycloak. Each fetch has a 5 second timeout. The first fetch is at the
  first token, not at start.
- After a fetch that failed, the verifier makes no fetch for 5 seconds.
  In that time, keys that are in the cache (and not older than 10 minutes)
  still work, and all other tokens get 503. So during a Keycloak outage,
  tokens with random `kid` values cause at most one fetch each 5 seconds,
  and only one warn line each 5 seconds.
- `bearerHook(verify)` is a `before` hook of `./http`. It accepts only
  `Authorization: Bearer <token>` (that case, one space, at most 8192
  characters, token characters of RFC 6750). It puts the subject in
  `request.state.subject`. `subjectOf(request)` gives it with its type.
  When the hook refuses a request that has a body (`content-length` above
  0 or `transfer-encoding`), the answer has `connection: close` and the
  server closes the socket, as for 413 and 415. It does not read the body.
  The hook runs before routing, so a request with no valid token gets 401
  on all paths, also on paths that do not exist. `/health`, `/ready` and
  `/metrics` have no hooks, so they stay open.
- No token or another scheme gives 401 with
  `WWW-Authenticate: Bearer realm="ai-systems"` and no error (RFC 6750).

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
- `URL` objects are logged with `[Redacted]` in place of the user name and
  the password. Errors keep their class name in `type`.
- Limits: the censor looks at keys only. A secret inside a string (the log
  message, an error message, a URL query) is not redacted. Other objects
  with `toJSON` (for example `Date`, `Buffer`) are logged as `toJSON` gives
  them, with no censor. Do not put secrets or prompt text in strings or in
  such objects.
- `startTelemetry({ serviceName, release, metricsPort })` starts the
  OpenTelemetry Node SDK with http and undici instrumentation and the env
  and service instance resource detectors only. Traces go over OTLP only
  when `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
  is set. Metrics are for Prometheus: on `/metrics` of the service (pass
  `telemetry.metricsHandler` to `createService`), or on `metricsPort`.
  `telemetry.counter()` and `telemetry.histogram()` make instruments.

Call `startTelemetry` before `createService`.

## `./mongo`

```ts
import { connectMongo, runMigrations } from "@famashines/ai-systems-kit/mongo";
import { eventStoreMigration } from "@famashines/ai-systems-kit/event-store";
import { processedMigration } from "@famashines/ai-systems-kit/messaging";

const mongo = await connectMongo({ url: config.MONGO_URL, database: "orchestration" });
await runMigrations(mongo.db, [eventStoreMigration, processedMigration, ...ownMigrations]);
```

- `connectMongo({ url, database, attempts = 10, delayMs = 1000, clientOptions })`
  tries to connect `attempts` times, then throws. It gives
  `{ client, db, ready, close }`. `ready` sends `ping`. Put `ready` in
  `readiness` and `close` in `closeHooks` of `createService`.
- `runMigrations(db, migrations)` runs each `{ name, up(db) }` that is not
  in the collection `migrations`, in name order, and records it. It gives
  the names that it ran. A name is `NNN-name`, for example
  `001-task-index`; a bad or repeated name throws. Run it before the
  service is ready. Two pods can start at the same time, so a migration
  must be safe to run two times (for example `createIndex`).
- The kit migrations are `000-event-store` (indexes of `events`, the TTL of
  `commands`, the `counters` document) and `000-processed` (the TTL of
  `processed`). Services start their own names at `001`.

## `./event-store`

```ts
import { createEventStore } from "@famashines/ai-systems-kit/event-store";

const store = createEventStore(mongo.db, { upcasters });
const { events, answer, replayed } = await store.append({
  streamId: `task-${taskId}`,
  expectedVersion: 0,
  events: [
    {
      type: "orchestration.TaskSubmitted",
      schemaVersion: 1,
      correlationId,
      causationId,
      actor,
      payload,
    },
  ],
  command: { commandId, answer: { taskId } },
});
```

- `createEventStore(db, { upcasters, parse, now, newId })`. `parse` is
  `parseEvent` of contracts by default.
- `append({ streamId, expectedVersion, events, command, also })` runs in
  one MongoDB transaction:

  ```
  commandId in commands?  --> yes: give the stored answer, write nothing
  last version of stream  --> check expectedVersion
  make each event: eventId, version, occurredAt, parse with contracts
  counters.events += n    --> positions, in commit order
  insert events, insert commands { commandId, answer }, run also(session)
  ```

  - `expectedVersion`: absent is no check, `0` is "the stream must not
    exist", `n` is "the last version must be `n`". A different version, or
    a duplicate `(streamId, version)` from a concurrent append, gives
    `ConcurrencyError` (a `ConflictError`, 409 `conflict`).
  - The same `commandId` gives `{ events: [], answer, replayed: true }`
    with the first answer, also when two appends with that id run at the
    same time. `commands` keeps ids for 45 days.
  - `also(session)` writes other documents (a state document, a processed
    marker) in the same transaction. Use `session` for each write. The
    driver can run the transaction again after a write conflict, so
    `also` can run more than one time before the commit.
  - The store also keeps the W3C `traceparent` of the active span, for the
    relay.

- `readStream(streamId, { fromVersion })` and
  `readAll({ afterPosition, limit = 100 })` give events with their
  `position`, after the upcasters and `parse`. `readAll` is for the
  internal replay API: page with the last `position`.
- Upcasters: `{ "<type>": { 1: (payloadV1) => payloadV2, 2: ... } }`. On
  read, the store runs the steps from the stored `schemaVersion` up, then
  `parse` checks the result. Stored events never change.
- Document in `events`: `_id` (the eventId), `streamId`, `version`, `type`,
  `schemaVersion`, `occurredAt`, `correlationId`, `causationId`, `actor`,
  `payload`, `position` (1, 2, 3 ... for each database), `publishedAt`
  (`null` until the relay publishes it), `traceparent` (if any). Indexes:
  unique `(streamId, version)`, unique `position`, and
  `(publishedAt, position)`. Only the kit writes to `events`, and it
  changes only `publishedAt`.
- An event larger than 900 KiB (its JSON) gives
  `DomainError("payload_too_large", 413)`, and the append writes nothing.
  NATS refuses messages above 1 MiB, so such an event would stop the relay.
- No snapshots (ADR 0006).

## `./messaging`

```ts
import { connectNats, startConsumer, startRelay } from "@famashines/ai-systems-kit/messaging";

const nats = await connectNats({ servers, user, pass, service: "orchestration", logger });
const relay = startRelay({ store, nats, streams: ["ORCHESTRATION"] });
const consumer = startConsumer({
  nats,
  db: mongo.db,
  stream: "CONVERSATION",
  filter: "conversation.OwnerMessagePosted",
  handler: async (event, { markProcessed }) => {
    await store.append({ streamId, events, also: markProcessed });
  },
});
```

- `connectNats({ servers, user, pass, service, logger })` gives
  `{ connection, service, logger, ready, close, request, serve }`. The inbox
  prefix is `_INBOX_<service>` (ADR 0023). It waits for the first
  connection, so a service starts its HTTP server only after NATS answers.
  It reconnects with no limit. `ready` sends a ping. `close` drains the
  connection.
- `startRelay({ store, nats, streams, pollMs = 1000, batch = 100 })` gives
  `{ ready, close }`. It wakes on a change stream of `events` and also
  polls each `pollMs`. It publishes the events with `publishedAt: null` in
  `position` order to the subject `type`, waits for the PubAck, then sets
  `publishedAt`. Headers: `Nats-Msg-Id` (the eventId), `correlation-id`,
  `causation-id`, and `traceparent` if the event has one. On a failure it
  stops the batch and tries again after 1, 2, 4 ... 30 s. It never makes
  streams. `ready` is `false` until each stream in `streams` exists
  (`$JS.API.STREAM.INFO.<stream>`).
- A stuck outbox: one event that NATS refuses stops all later events. The
  relay logs an error at the first failure and then each 30 s while it
  fails, and it does not change `ready` (the HTTP API stays up). Metrics
  (through the meter that `startTelemetry` installs; call it before
  `startRelay`): the gauge `outbox_oldest_pending_seconds` (age of the
  oldest event that is not published, 0 when the outbox is empty) and the
  counter `outbox_publish_failures_total`. Each service needs an alert on
  the gauge, for example above 60 s for 5 min.
- `startConsumer({ nats, db, stream, filter, handler, upcasters, parse, batch = 10, ordered = false })`
  gives `{ ready, close }`. The durable consumer has the name of the
  service and one fixed `filter`. The kit makes it with
  `$JS.API.CONSUMER.CREATE.<stream>.<service>.<filter>` (create or update),
  explicit ack, `max_deliver` 5 and backoff 1 s, 5 s, 30 s, 2 min. If the
  stream does not exist yet, it tries again and `ready` stays `false`.
- Each message:

  ```
  JSON, upcasters, parse fail --> DLQ at once, ack
  eventId in processed        --> ack, no handler
  handler(event, { session, markProcessed })
    ok                        --> ack
    MongoDB or NATS is down   --> keep the message, try again locally
    fails, eventId now in processed --> ack
    fails, delivery 1 to 4    --> nak with the backoff delay
                                  (ordered: keep it, wait, try again locally)
    fails, delivery 5         --> DLQ, ack after the DLQ PubAck
  ```

- MongoDB or NATS down, in the kit calls (the `processed` check): a
  `MongoNetworkError`, `MongoServerSelectionError` (and
  `PoolClearedError`), a NATS timeout, no responders or connection error,
  or a socket error (`ECONNRESET`, `EPIPE` ...) does not use a delivery.
  The kit keeps the message, sends "in progress", and tries again after 1,
  2, 4 ... 30 s. It logs an error at the first failure and each 30 s.
- A handler error: the kit does not look at the error class. It sends
  `ping` to the consumer `db` and a NATS ping, with a 2 s limit. If one of
  them fails, MongoDB or NATS is down: the kit keeps the message, waits
  until both answer again, and then runs the handler again (no new
  delivery). Before it runs the handler again, it checks the `processed`
  marker again: a long outage can give the message to another pod, and if
  that pod processed it, the kit acks it with no new run. If both answer, the error is a handler failure and counts as
  a delivery (nak with the backoff, or the ordered local retry, then the
  DLQ after 5 tries). So a handler bug that throws an error which looks
  like a network error still goes to the DLQ.
- The DLQ publish tries again until it works. The kit acks the message
  only after the DLQ PubAck.
- Held messages: the gauge `consumer_oldest_held_seconds` (labels `stream`,
  `durable`) gives the age of the oldest message that the consumer has and
  did not ack yet, 0 when it has none. A DLQ publish that fails for a
  permanent reason (for example no permission on `dlq.<service>.>`) keeps
  a message for ever with only this signal. Each service needs an alert on
  the gauge, for example above 300 s.
- At least once: a message can come more than one time, for example after
  a crash before the ack. So the handler writes its effect and
  `markProcessed(session)` in one transaction: with
  `session.withTransaction`, or with `store.append({ ..., also:
markProcessed })`. `markProcessed` throws if the session is not in a
  transaction. `processed` keeps event ids for 45 days. A handler with no
  effect does not have to mark the event.
- Order: without `ordered`, the order of events is not certain. A failed
  event comes again after the events behind it, and two pods handle
  messages at the same time. So a handler keeps its own checkpoint for each
  stream (the last `event.version` that it applied) and checks
  `event.version` against it. With `ordered: true`, the consumer has
  `max_ack_pending` 1: NATS gives one message at a time to all pods
  together, and a failed message stays with its pod and is tried again
  locally with the backoff steps (then the DLQ after 5 tries). So the next
  message cannot pass it. This is slower. All pods of a service must use
  the same `ordered` value.
- With a backoff, NATS uses the first backoff step (1 s) as the ack wait.
  So the kit sends "in progress" for each message of the batch until it is
  acked. A slow handler does not cause a second delivery.
- DLQ: subject `dlq.<service>.<original subject>`, in the stream `DLQ`.
  The data is the original message. Headers: `error-class` (for example
  `ZodError`, `SyntaxError`, `NotFoundError`), `error-message` (at most 500
  printable ASCII characters), and `correlation-id`, `causation-id`,
  `traceparent` of the original message.
- Error text in headers and logs: the kit uses `describeError`. A JSON
  error gives a fixed message, a zod error gives the paths and issue codes
  only, and a `MongoServerError` gives its code and code name (its message
  can contain key values). `./messaging` never logs these raw messages or
  the stack. The message of your own errors goes to the logs and the DLQ
  headers: do not put payload values or secrets in it.
- rpc on core NATS, for `rpc.*` subjects (ADR 0021):

  ```ts
  nats.serve("rpc.budget.reserve", ReserveV1, ReservationV1, (input) => reserve(input), {
    allowReplyPrefixes: ["_INBOX_orchestration.", "_INBOX_ai-proxy."],
  });
  const reservation = await nats.request(
    "rpc.budget.reserve",
    ReserveV1,
    ReservationV1,
    input,
    2000,
  );
  ```

  `serve` first drops each request whose reply subject does not start with
  one of `allowReplyPrefixes` (ADR 0025): no parse, no handler, no answer.
  It counts them in `rpc_requests_dropped_total` and writes a debug log.
  Then both ends check with zod. `serve` uses a queue group, so one
  replica answers. A `DomainError` in the handler goes to the caller with
  its `code`, `status` and `message` (headers `error-code`, `error-status`,
  `error-message`); a `ValidationError` also keeps its `issues`. Other
  errors give `internal` with no detail and go to the log. No answer in
  time gives `UnavailableError`. `request` and `serve` also exist as
  functions that take the connection.

## Known limits

- All appends of one database write one `counters` document, so they wait
  for each other. Measured: about 110 appends/s. This keeps `position` in
  commit order.
- The relay publishes one event at a time and waits for each PubAck.
  Measured: about 163 events/s.
- A pod that stops while it keeps a message (MongoDB or NATS down, or an
  ordered retry) does not ack it. NATS delivers it again later, and that
  uses a delivery.
- If a pod stops while the DLQ publish of the last delivery fails, NATS
  does not deliver the message again. It stays in the stream, and NATS
  sends a max deliveries advisory.
- The in-memory store gives `also` a fake session.

## `./testing`

```ts
import {
  createMemoryEventStore,
  fakeClock,
  fakeIds,
  startMongo,
  startNats,
  createStreams,
  waitFor,
} from "@famashines/ai-systems-kit/testing";

const store = createMemoryEventStore({ now: fakeClock().now, newId: fakeIds() });
const mongo = await startMongo();
const nats = await startNats({ config });
```

- `createMemoryEventStore(options)` has the interface of the MongoDB store
  and the same version and command id rules. `also` gets a fake session:
  it can fail the append, but it cannot write to MongoDB.
- `fakeClock(start)` gives `{ now, advance(ms), set(date) }`.
  `fakeIds(prefix)` gives lower-case UUID v4 values in order.
  `waitFor(check, timeoutMs, everyMs)` waits until `check` is true. Use it
  in place of fixed sleeps.
- `startMongo()` starts `mongo:8.0.34` (pinned by digest) as a replica set
  with one member. `startNats({ config })` starts `nats:2.15.2-alpine`
  (pinned by digest) with a config string, so a
  test can use real accounts and permissions. The default config is
  JetStream only. Both give `{ url, stop }`.
- `createStreams(admin, specs)` makes streams (duplicate window 10 min) in
  tests. Services never make streams (ADR 0023).

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

## Local system

`compose.yaml` starts the full M1 system on one machine (ADR 0011,
ADR 0017). It builds the four services from the sibling folders with their
own Dockerfiles. NATS has the AISYSTEMS account with the gitops grants of
each service (ADR 0023), and a local OIDC issuer signs real RS256 tokens.

```
                 localhost:8082 issuer (dev only, key made at start)
                        | JWKS                    | JWKS
localhost:8080 /api --> api-gateway        socket-gateway <-- localhost:8081 /ws
                        |       \                 ^
                        v        v                | VIEWS (ordered consumer)
               orchestration   projections -------+
                        |  \      |   ^
                        v   \     v   | ORCHESTRATION (durable "projections")
               MongoDB rs0   +--> NATS (account AISYSTEMS, 8 streams)
               (1 member)
```

### Quickstart in 10 minutes

You need git, Docker with Compose v2, and Node 26. The workspace layout
is fixed: the services are in `../services/ai-systems-<name>`.

```sh
mkdir -p ai-systems/services && cd ai-systems
git clone https://github.com/famashines/ai-systems-kit.git kit
for name in orchestration projections api-gateway socket-gateway; do
  git clone https://github.com/famashines/ai-systems-$name.git services/ai-systems-$name
done
cd kit
npm run dev:up
npm run dev:e2e
npm run dev:down
```

No `npm ci` is necessary: the scripts use only Node and Docker.

| Command            | Does                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `npm run dev:up`   | makes `.env.local` if it is not there, builds the images, starts all containers and waits until all are healthy |
| `npm run dev:e2e`  | runs `dev/e2e.ts` against the running system and prints a PASS or FAIL table (exit code 1 on FAIL)              |
| `npm run dev:down` | stops all containers and deletes the volumes                                                                    |
| `npm run dev:sync` | copies the gitops sources again (see below); needs a gitops checkout                                            |

Each `docker compose` command needs `--env-file .env.local`, for example
`docker compose --env-file .env.local logs -f projections`.

### Ports

Only these ports are on the host, and only on `127.0.0.1`:

| Port   | Container      | Paths                                                      |
| ------ | -------------- | ---------------------------------------------------------- |
| `8080` | api-gateway    | `/api/tasks`, `/health`, `/ready`, `/metrics`              |
| `8081` | socket-gateway | `/ws`, `/health`, `/ready`, `/metrics`                     |
| `8082` | issuer         | `/realms/ai-systems/...` (discovery, JWKS, token endpoint) |

MongoDB, NATS, orchestration and projections have no host port. Use
`docker compose --env-file .env.local exec` to reach them.

### Tokens

`dev/issuer/server.ts` has no dependencies. At start it makes an RSA key.
It serves `/realms/ai-systems/.well-known/openid-configuration`, the JWKS
at `/realms/ai-systems/protocol/openid-connect/certs` (the kit/auth
default) and a token endpoint. Each `POST` to the token endpoint gives an
access token for one hour: RS256, `iss`
`http://issuer:8080/realms/ai-systems`, `aud` and `azp` `ai-systems-app`,
`typ` `Bearer`, realm role `owner`, and a fixed `sub`.

```sh
token=$(curl -s -X POST localhost:8082/realms/ai-systems/protocol/openid-connect/token | node -p 'JSON.parse(require("fs").readFileSync(0)).access_token')
curl -s -H "authorization: Bearer $token" localhost:8080/api/tasks
```

The gateways check the `iss` with the container name `issuer`, so the
token is the same from the host and from a container. A new start of the
issuer makes a new key: get a new token.

### Passwords

`dev/env.sh` writes `.env.local` with a random password for each MongoDB
user and each NATS user. Git ignores `.env.local`; never commit it. The
script does not change a file that exists, because the MongoDB root user
keeps its first password in the volume. `npm run dev:down` deletes the
volumes, so you can delete `.env.local` after it. The MongoDB key file is
made again at each start of the container (one member does not share it).

### Sources from gitops

The local system uses the gitops files, not a copy written by hand:

| Local file               | gitops source (`origin/main`)                                                     |
| ------------------------ | --------------------------------------------------------------------------------- |
| `dev/mongo/init.js`      | `kubernetes/ai-systems/ai-systems-mongodb/base/init.js`                           |
| `dev/nats/streams/*`     | `kubernetes/infrastructure/nats/manifests/ai-systems-streams/*`                   |
| `dev/nats/accounts.conf` | `config.merge.accounts.AISYSTEMS` in `kubernetes/infrastructure/nats/values.yaml` |

`npm run dev:sync` (`dev/sync-gitops.ts`) writes these files again from
the gitops checkout at `../../../platform/gitops` (set `GITOPS_DIR` and
`GITOPS_REF` to change it) and prints the gitops commit. It converts the
account to NATS config JSON, and each `<< $NAME >>` password to the env
var `$NAME`. The files are from gitops `13f559f`. gitops is private, so
CI cannot read it: run the sync and commit the result when the grants or
the streams change in gitops. ESLint and Prettier do not check these
files, so they stay the same as in gitops.

The one-shot containers `mongodb-init` and `nats-streams` run the same
`init.js` and `streams.sh` as the gitops Jobs, with the same images. The
services start only after both end with exit code 0.

### Known limits

- `nats-streams` logs one publish violation on `$SYS.REQ.USER.INFO`. It
  comes from `nats account info` in the gitops `streams.sh`, and the
  cluster has it too. It does not stop the script.
- The system has no LLM, budget or conversation services yet (M1). The
  e2e checks the task submit, the read model, the notices and the resume.
- The first `npm run dev:up` builds four images and downloads the base
  images. Later starts use the Docker build cache.

### CI

The `e2e` job in `.github/workflows/ci.yml` checks out kit and the four
service repos at `main` in the same layout, runs `npm run dev:up` and
`npm run dev:e2e`, and uploads the container logs when a step fails. It
runs on `ubuntu-22.04` for the MongoDB kernel reason in `CLAUDE.md`.

## Commands

See `CLAUDE.md`.
