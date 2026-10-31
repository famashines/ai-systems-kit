import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { startTelemetry } from "./index.ts";

const received: string[] = [];
const collector = createServer((request, response) => {
  received.push(request.url ?? "");
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/x-protobuf" }).end();
  });
});
await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
const free = createServer();
await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
const metricsPort = (free.address() as AddressInfo).port;
await new Promise((resolve) => free.close(resolve));

process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://127.0.0.1:${String((collector.address() as AddressInfo).port)}/v1/traces`;
const telemetry = startTelemetry({ serviceName: "orchestration", release: "v2", metricsPort });
const { createService } = await import("../http/index.ts");
const { createLogger } = await import("./index.ts");

after(async () => {
  await telemetry.shutdown();
  collector.close();
});

test("exports traces over OTLP and logs the trace id", async () => {
  const logs: string[] = [];
  const logger = createLogger({
    service: "orchestration",
    release: "v2",
    destination: { write: (line: string) => logs.push(line) },
  });
  const service = createService({
    logger,
    routes: [
      {
        method: "GET",
        path: "/work",
        handler: () => {
          logger.info("work");
          return {};
        },
      },
    ],
  });
  const { port } = await service.listen(0, "127.0.0.1");
  await (await fetch(`http://127.0.0.1:${String(port)}/work`)).text();
  await service.close();
  const entry = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
  assert.match(String(entry.traceId), /^[0-9a-f]{32}$/);
  assert.notEqual(entry.traceId, "0".repeat(32));

  const metrics = await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`);
  assert.match(await metrics.text(), /service_name="orchestration"/);

  await telemetry.shutdown();
  assert.ok(received.includes("/v1/traces"));
});
