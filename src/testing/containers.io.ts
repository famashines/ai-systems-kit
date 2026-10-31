import { jetstreamManager, type StreamConfig } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";

export const mongoImage =
  "mongo:8.0.34@sha256:b9924c330a8bbc5800fe9c69f04a84e221eca7b28fd049a0354147d9908fa142";
export const natsImage =
  "nats:2.15.2-alpine@sha256:823e7f1d6d8ffe3b30dbd73d4a06bbb939acf94929f7fdf224404da7a05bafb5";

export interface Started {
  url: string;
  stop: () => Promise<void>;
}

export async function startMongo(): Promise<Started> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const container = await new GenericContainer(mongoImage)
    .withCommand(["--replSet", "rs0", "--bind_ip_all"])
    .withExposedPorts(27017)
    .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
    .start();
  const result = await container.exec([
    "mongosh",
    "--quiet",
    "--eval",
    "rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'localhost:27017' }] }); while (!db.hello().isWritablePrimary) sleep(100);",
  ]);
  if (result.exitCode !== 0) throw new Error(`rs.initiate failed: ${result.output}`);
  return {
    url: `mongodb://${container.getHost()}:${String(container.getMappedPort(27017))}/?directConnection=true`,
    stop: async () => {
      await container.stop();
    },
  };
}

export async function startNats(options: { config?: string } = {}): Promise<Started> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const config = options.config ?? "jetstream { store_dir: /data }";
  const container = await new GenericContainer(natsImage)
    .withCopyContentToContainer([{ content: config, target: "/etc/nats/test.conf" }])
    .withCommand(["nats-server", "-c", "/etc/nats/test.conf"])
    .withTmpFs({ "/data": "rw" })
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start();
  return {
    url: `nats://${container.getHost()}:${String(container.getMappedPort(4222))}`,
    stop: async () => {
      await container.stop();
    },
  };
}

export type StreamSpec = Partial<StreamConfig> & { name: string; subjects: string[] };

export async function createStreams(
  admin: NatsConnection,
  specs: readonly StreamSpec[],
): Promise<void> {
  const manager = await jetstreamManager(admin);
  for (const spec of specs) {
    await manager.streams.add({ duplicate_window: 600_000_000_000, ...spec });
  }
}
