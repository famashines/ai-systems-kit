import { metrics, type Attributes, type ObservableResult } from "@opentelemetry/api";

export function observeGauge(
  meter: string,
  name: string,
  description: string,
  read: () => number,
  attributes?: Attributes,
): () => void {
  const gauge = metrics.getMeter(meter).createObservableGauge(name, { description });
  const callback = (result: ObservableResult): void => {
    result.observe(read(), attributes);
  };
  gauge.addCallback(callback);
  return () => {
    gauge.removeCallback(callback);
  };
}
