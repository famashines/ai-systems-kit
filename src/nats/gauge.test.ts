import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { startTelemetry } from "../observability/index.ts";
import { observeGauge } from "./index.ts";

delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const telemetry = startTelemetry({ serviceName: "gauges", release: "v1" });
const server = createServer(telemetry.metricsHandler);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const scrape = async (): Promise<string> =>
  (await fetch(`http://127.0.0.1:${String(port)}/metrics`)).text();

after(async () => {
  server.close();
  await telemetry.shutdown();
});

test("observeGauge reads the value at each scrape until it is removed", async () => {
  let open = 3;
  const remove = observeGauge("kit-test", "open_things", "Open things", () => open, {
    stream: "VIEWS",
  });
  assert.match(await scrape(), /open_things\{stream="VIEWS",otel_scope_name="kit-test"\} 3/);
  open = 5;
  assert.match(await scrape(), /open_things\{stream="VIEWS",otel_scope_name="kit-test"\} 5/);
  remove();
  open = 7;
  const last = await scrape();
  assert.match(last, /open_things\{stream="VIEWS",otel_scope_name="kit-test"\} 5/);
  assert.doesNotMatch(last, /open_things\{.*\} 7/);
});
