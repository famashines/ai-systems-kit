import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pino } from "pino";
import { createService, type ServiceOptions } from "./index.ts";

const lines: string[] = [];
const logger = pino({ level: "debug" }, { write: (line: string) => lines.push(line) });
const services: { close(): Promise<boolean> }[] = [];

after(async () => {
  await Promise.all(services.map((service) => service.close()));
});

async function start(options: Partial<ServiceOptions> = {}) {
  const service = createService({ routes: [], logger, drainDelayMs: 0, ...options });
  services.push(service);
  const { port } = await service.listen(0, "127.0.0.1");
  return { service, url: `http://127.0.0.1:${String(port)}` };
}

function gate() {
  const started = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  return {
    started: started.promise,
    release: () => {
      released.resolve(undefined);
    },
    wait: () => {
      started.resolve(undefined);
      return released.promise;
    },
  };
}

test("waits for an in-flight request, then runs close hooks in reverse", async () => {
  const order: string[] = [];
  const slow = gate();
  const { service, url } = await start({
    routes: [
      {
        method: "GET",
        path: "/slow",
        handler: async () => {
          await slow.wait();
          order.push("request done");
          return { body: { done: true } };
        },
      },
    ],
    closeHooks: [
      () => {
        order.push("mongo");
      },
      async () => {
        await sleep(1);
        order.push("telemetry");
      },
    ],
  });
  const inFlight = fetch(`${url}/slow`);
  await slow.started;
  const closed = service.close();
  assert.equal(service.close(), closed);
  await sleep(20);
  assert.deepEqual(order, []);
  slow.release();
  const response = await inFlight;
  assert.equal(response.headers.get("connection"), "close");
  assert.deepEqual(await response.json(), { done: true });
  assert.equal(await closed, true);
  assert.deepEqual(order, ["request done", "telemetry", "mongo"]);
  await assert.rejects(fetch(`${url}/slow`));
});

test("keeps accepting during the drain delay with /ready at 503", async () => {
  const { service, url } = await start({
    drainDelayMs: 200,
    routes: [{ method: "GET", path: "/work", handler: () => ({ body: { ok: true } }) }],
  });
  const closed = service.close();
  const ready = await fetch(`${url}/ready`);
  assert.equal(ready.status, 503);
  assert.equal(ready.headers.get("connection"), "close");
  assert.deepEqual(((await ready.json()) as { failing: string[] }).failing, ["shutdown"]);
  const work = await fetch(`${url}/work`);
  assert.equal(work.status, 200);
  await work.text();
  assert.equal(await closed, true);
  await assert.rejects(fetch(`${url}/work`));
});

test("lists shutdown and the failing checks on /ready", async () => {
  const check = gate();
  const { service, url } = await start({
    readiness: { mongo: () => check.wait().then(() => false) },
  });
  const ready = fetch(`${url}/ready`);
  await check.started;
  const closed = service.close();
  check.release();
  const response = await ready;
  assert.equal(response.status, 503);
  assert.deepEqual(((await response.json()) as { failing: string[] }).failing, [
    "shutdown",
    "mongo",
  ]);
  await closed;
});

test("closes open connections at the deadline and reports it", async () => {
  const hang = gate();
  const { service, url } = await start({
    shutdownTimeoutMs: 100,
    routes: [
      {
        method: "GET",
        path: "/hang",
        handler: async () => {
          await hang.wait();
          return {};
        },
      },
    ],
  });
  const inFlight = fetch(`${url}/hang`);
  await hang.started;
  const started = Date.now();
  assert.equal(await service.close(), false);
  assert.ok(Date.now() - started < 1000);
  await assert.rejects(inFlight);
  assert.ok(lines.some((line) => line.includes("shutdown deadline passed")));
});

test("bounds a close hook that hangs with a live handle and runs the others", async () => {
  const order: string[] = [];
  let handle: NodeJS.Timeout | undefined;
  const { service } = await start({
    shutdownTimeoutMs: 100,
    closeHooks: [
      () => {
        order.push("first");
      },
      () => {
        throw new Error("nats close failed");
      },
      () =>
        new Promise<void>(() => {
          handle = setInterval(() => undefined, 1000);
        }),
    ],
  });
  const started = Date.now();
  assert.equal(await service.close(), false);
  clearInterval(handle);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(order, ["first"]);
  assert.ok(lines.some((line) => line.includes("close hook failed")));
  assert.ok(lines.some((line) => line.includes("did not end before the shutdown deadline")));
});

test("handleSignals is idempotent and exits once with 0", async () => {
  const { service } = await start();
  const known = new Set([...process.listeners("SIGTERM"), ...process.listeners("SIGINT")]);
  const codes: number[] = [];
  service.handleSignals((code) => codes.push(code));
  service.handleSignals((code) => codes.push(code));
  process.emit("SIGTERM", "SIGTERM");
  process.emit("SIGINT", "SIGINT");
  await service.close();
  await sleep(10);
  assert.deepEqual(codes, [0]);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!known.has(listener)) process.off(signal, listener);
    }
  }
});

test("exits with 1 when a hook awaits a promise with no handle", async () => {
  const kit = new URL("./index.ts", import.meta.url).href;
  const script = `
    import { createService } from ${JSON.stringify(kit)};
    import { pino } from "pino";
    const service = createService({
      routes: [],
      logger: pino({ level: "silent" }),
      drainDelayMs: 0,
      shutdownTimeoutMs: 200,
      closeHooks: [
        () => { console.log("first hook"); },
        () => new Promise(() => {}),
      ],
    });
    await service.listen(0, "127.0.0.1");
    service.handleSignals();
    process.kill(process.pid, "SIGTERM");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("../..", import.meta.url),
  });
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  const [code] = (await once(child, "exit")) as [number];
  assert.equal(code, 1);
  assert.match(output, /first hook/);
});
