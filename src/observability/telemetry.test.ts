import assert from "node:assert/strict";
import { after, test } from "node:test";
import { trace } from "@opentelemetry/api";
import { startTelemetry } from "./index.ts";

delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const telemetry = startTelemetry({ serviceName: "gateway", release: "v1" });
const { createService } = await import("../http/index.ts");
const { createLogger } = await import("./index.ts");

const logs: string[] = [];
const logger = createLogger({
  service: "gateway",
  release: "v1",
  destination: { write: (line: string) => logs.push(line) },
});
const service = createService({
  logger,
  metrics: telemetry.metricsHandler,
  closeHooks: [() => telemetry.shutdown()],
  routes: [
    {
      method: "GET",
      path: "/work",
      handler: () => {
        assert.ok(trace.getActiveSpan());
        logger.info("work");
        return { body: {} };
      },
    },
  ],
});
const { port } = await service.listen(0, "127.0.0.1");
const url = `http://127.0.0.1:${String(port)}`;

after(() => service.close());

test("serves custom and http metrics on /metrics of the same server", async () => {
  telemetry.counter("tasks_submitted", "Tasks submitted").add(2, { agent: "writer" });
  telemetry.histogram("llm_call_duration", "LLM call time", "s").record(0.5);
  telemetry.histogram("plain_histogram", "No unit").record(1);
  await (await fetch(`${url}/work`)).text();
  const response = await fetch(`${url}/metrics`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /tasks_submitted_total\{agent="writer",otel_scope_name="gateway"\} 2/);
  assert.match(text, /llm_call_duration/);
  assert.match(text, /http_server_request_duration_count/);
  assert.match(text, /service_name="gateway",service_version="v1"/);
});

test("logs no trace id without an OTLP endpoint", () => {
  const entry = JSON.parse(logs.at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(entry.msg, "work");
  assert.equal(entry.traceId, undefined);
  assert.equal(typeof entry.requestId, "string");
});
