import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { metrics, type Counter, type Histogram } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import {
  envDetector,
  resourceFromAttributes,
  serviceInstanceIdDetector,
} from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";

const probes = new Set(["/health", "/ready", "/metrics"]);
const isProbe = (url = ""): boolean => probes.has(url.split("?")[0] ?? "");

export interface TelemetryOptions {
  serviceName: string;
  release: string;
  metricsPort?: number;
}

export interface Telemetry {
  metricsHandler: (request: IncomingMessage, response: ServerResponse) => void;
  counter: (name: string, description: string) => Counter;
  histogram: (name: string, description: string, unit?: string) => Histogram;
  shutdown: () => Promise<void>;
}

export function startTelemetry(options: TelemetryOptions): Telemetry {
  const exporter = new PrometheusExporter(
    options.metricsPort === undefined
      ? { preventServerStart: true }
      : { host: "0.0.0.0", port: options.metricsPort },
  );
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": options.serviceName,
      "service.version": options.release,
    }),
    resourceDetectors: [envDetector, serviceInstanceIdDetector],
    metricReaders: [exporter],
    logRecordProcessors: [],
    ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      ? { traceExporter: new OTLPTraceExporter() }
      : { spanProcessors: [] }),
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (request) => isProbe(request.url) }),
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();
  const require = createRequire(import.meta.url);
  require("node:http");
  require("node:https");
  syncBuiltinESMExports();
  const meter = metrics.getMeter(options.serviceName);
  return {
    metricsHandler: (request, response) => {
      exporter.getMetricsRequestHandler(request, response);
    },
    counter: (name, description) => meter.createCounter(name, { description }),
    histogram: (name, description, unit) =>
      meter.createHistogram(name, unit === undefined ? { description } : { description, unit }),
    shutdown: () => sdk.shutdown(),
  };
}
