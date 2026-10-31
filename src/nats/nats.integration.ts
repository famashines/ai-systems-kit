import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { createStreams, startNats, waitFor, type Started } from "../testing/index.ts";
import { connectNats, orderedStream, type Nats, type OrderedMessage } from "./index.ts";

const gatewayGrants = [
  "$JS.API.INFO",
  "$JS.API.STREAM.INFO.VIEWS",
  "$JS.API.CONSUMER.CREATE.VIEWS",
  "$JS.API.CONSUMER.CREATE.VIEWS.>",
  "$JS.API.CONSUMER.INFO.VIEWS.*",
  "$JS.API.CONSUMER.DELETE.VIEWS.*",
  "$JS.API.CONSUMER.MSG.NEXT.VIEWS.*",
];

const list = (subjects: string[]): string => subjects.map((s) => `"${s}"`).join(", ");

const config = `
jetstream { store_dir: /data }
accounts {
  AISYSTEMS {
    jetstream { max_file: 1073741824, max_memory: 0 }
    users = [
      {
        user: admin, password: admin
        permissions {
          publish { allow: ["$JS.API.>", "view.>"] }
          subscribe { allow: ["_INBOX_admin.>"] }
        }
      }
      {
        user: gateway, password: gateway
        permissions {
          publish { allow: [${list(gatewayGrants)}] }
          subscribe { allow: ["_INBOX_socket-gateway.>", "delta.>"] }
        }
      }
    ]
  }
}
`;

const views = { name: "VIEWS", subjects: ["view.>"] };
let server: Started;
let admin: Nats;
let gateway: Nats;

before(async () => {
  server = await startNats({ config });
  [admin, gateway] = await Promise.all([
    connectNats({ servers: server.url, user: "admin", pass: "admin", service: "admin" }),
    connectNats({
      servers: server.url,
      user: "gateway",
      pass: "gateway",
      service: "socket-gateway",
    }),
  ]);
  await createStreams(admin.connection, [views]);
});

after(async () => {
  await Promise.all([admin.close(), gateway.close()]);
  await server.stop();
});

const consumers = async (): Promise<number> => {
  const manager = await jetstreamManager(admin.connection);
  return (await manager.streams.info("VIEWS")).state.consumer_count;
};

test("connectNats uses the service inbox prefix and is ready", async () => {
  assert.equal(await gateway.ready(), true);
  const reply = await gateway.connection.request("$JS.API.INFO");
  assert.match(reply.subject, /^_INBOX_socket-gateway\./);
});

test("orderedStream gives the head and messages in order from startSeq", async () => {
  const js = jetstream(admin.connection);
  for (const subject of ["view.task.a", "view.task.b", "view.other.c", "view.task.d"]) {
    await js.publish(subject, subject);
  }
  const stream = await orderedStream(gateway, "VIEWS");
  const head = await stream.head();
  assert.deepEqual(head, { first: 1, last: 4 });
  const seen: OrderedMessage[] = [];
  const errors: unknown[] = [];
  const stop = await stream.consume({
    subjects: ["view.task.>"],
    startSeq: 2,
    onMessage: (message) => seen.push(message),
    onError: (error) => errors.push(error),
    onGone: () => errors.push("gone"),
  });
  await waitFor(() => seen.length === 2);
  assert.deepEqual(seen, [
    { seq: 2, subject: "view.task.b", data: "view.task.b" },
    { seq: 4, subject: "view.task.d", data: "view.task.d" },
  ]);
  assert.equal(await consumers(), 1);
  await stop();
  assert.equal(await consumers(), 0);
  assert.deepEqual(errors, []);
});

test("orderedStream calls onGone when the stream is deleted", async () => {
  const stream = await orderedStream(gateway, "VIEWS");
  let gone = false;
  const stop = await stream.consume({
    subjects: ["view.>"],
    startSeq: (await stream.head()).last + 1,
    onMessage: () => undefined,
    onError: () => undefined,
    onGone: () => {
      gone = true;
    },
  });
  const manager = await jetstreamManager(admin.connection);
  await manager.streams.delete("VIEWS");
  await waitFor(() => gone);
  await assert.rejects(stop());
  await createStreams(admin.connection, [views]);
});
