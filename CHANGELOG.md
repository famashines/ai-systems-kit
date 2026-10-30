# Changelog

## Unreleased

- `./http`: server on `node:http` with router, JSON body limit, zod
  validation, typed errors to problem JSON, request and correlation ids,
  before hooks, `/health`, `/ready`, `/metrics` and graceful shutdown.
- `./config`: `loadConfig` and `commonEnv`.
- `./observability`: `createLogger` with redaction and `startTelemetry`
  with OTLP traces and Prometheus metrics.
