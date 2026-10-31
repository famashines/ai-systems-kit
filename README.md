# ai-systems-kit

Shared server code of ai-systems. Each service installs it from a git tag.
Reasons and the dependency list: ADR 0003, 0004, 0017 and 0018 in
`ai-systems-docs`.

```
@famashines/ai-systems-kit
├── ./http           server on node:http, router, body, zod, problem JSON, ids, health, ready, shutdown
├── ./config         env vars checked with zod at start
├── ./observability  pino logger with redaction, OpenTelemetry traces and metrics
├── ./mongo          MongoDB connect with retry, ping readiness, migrations
├── ./event-store    events on MongoDB: append with expected version, command ids, upcasters, replay
├── ./messaging      NATS connect, outbox relay, durable consumer with DLQ, rpc request and serve
└── ./testing        in-memory event store, fake clock and ids, waitFor, Testcontainers helpers
```

## Install

```sh
npm install github:famashines/ai-systems-kit#v0.1.0
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
`@nats-io/transport-node` and `@nats-io/jetstream`. Peer dependencies: a
service installs `mongodb` (7.8.0) and `zod` (4.6.7) itself, so that it and
the kit use one copy (two copies break the `Db` and `ClientSession` types
and `instanceof MongoServerError`). `testcontainers` is an optional peer
dependency: install it as a dev dependency when you use `startMongo` or
`startNats`.

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

- MongoDB or NATS down: a `MongoNetworkError`, `MongoServerSelectionError`
  (and `PoolClearedError`), a NATS timeout, no responders or connection
  error, or a socket error (`ECONNRESET`, `EPIPE` ...) does not use a
  delivery. The kit keeps the message, sends "in progress", and tries
  again after 1, 2, 4 ... 30 s until MongoDB or NATS is back. It logs an
  error at the first failure and each 30 s. Only other handler errors count
  as deliveries.
- The DLQ publish also tries again until it works. The kit acks the
  message only after the DLQ PubAck.
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

## Commands

See `CLAUDE.md`.
