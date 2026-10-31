import { randomUUID } from "node:crypto";

const apiUrl = process.env.API_URL ?? "http://localhost:8080";
const wsUrl = process.env.WS_URL ?? "ws://localhost:8081/ws";
const issuerUrl = process.env.ISSUER_URL ?? "http://localhost:8082/realms/ai-systems";
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 15000);
const quietMs = 1500;

type Frame = { type: string } & Record<string, unknown>;
interface Notice extends Frame {
  seq: number;
  topic: string;
  docId: string;
  rev: number;
  commandId?: string;
}
interface TaskList {
  items: { taskId: string }[];
  headSeq: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message: string): never {
  throw new Error(message);
}

async function connect(url: string) {
  const socket = new WebSocket(url);
  const frames: Frame[] = [];
  let wake = (): void => undefined;
  let closed: string | undefined;
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as Frame);
    wake();
  });
  socket.addEventListener("close", (event) => {
    closed = `closed ${String(event.code)} ${event.reason}`;
    wake();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      resolve();
    });
    socket.addEventListener("error", () => {
      reject(new Error(`cannot open ${url}`));
    });
  });
  const notices = (): Notice[] =>
    frames.filter((frame): frame is Notice => frame.type === "notice");
  async function until<T>(what: string, pick: () => T | undefined): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = pick();
      if (found !== undefined) return found;
      if (closed) fail(`${what}: socket ${closed}`);
      const left = deadline - Date.now();
      if (left <= 0)
        fail(`${what}: no frame in ${String(timeoutMs)} ms, got ${JSON.stringify(frames)}`);
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, left);
      });
    }
  }
  const next = (type: string): Promise<Frame> =>
    until(type, () => frames.find((frame) => frame.type === type));
  return {
    frames,
    notices,
    until,
    next,
    send: (frame: object) => {
      socket.send(JSON.stringify(frame));
    },
    close: async () => {
      socket.close(1000);
      await until("close", () => closed);
    },
  };
}

async function api(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${apiUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

const rows: { step: string; result: "PASS" | "FAIL" | "SKIP"; detail: string }[] = [];
async function step(name: string, run: () => Promise<string>): Promise<void> {
  if (rows.some((row) => row.result === "FAIL")) {
    rows.push({ step: name, result: "SKIP", detail: "an earlier step failed" });
    return;
  }
  try {
    rows.push({ step: name, result: "PASS", detail: await run() });
  } catch (error) {
    rows.push({
      step: name,
      result: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

let token = "";
const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });
const submit = (key: string, text: string) =>
  api("/api/tasks", {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ text, mode: "auto" }),
  });
const taskIdOf = (result: { status: number; body: unknown }): string => {
  const taskId = (result.body as { taskId?: unknown } | undefined)?.taskId;
  if (result.status !== 202 || typeof taskId !== "string") {
    fail(`POST /api/tasks gave ${String(result.status)} ${JSON.stringify(result.body)}`);
  }
  return taskId;
};

type Client = Awaited<ReturnType<typeof connect>>;
let socket: Client;
let headSeq = 0;
let fromSeq = 0;
let lastSeq = 0;
let taskId = "";
const key = randomUUID();
const offlineKeys = [randomUUID(), randomUUID()];
const offlineTasks: string[] = [];

await step("GET /api/tasks with no token gives 401", async () => {
  const { status } = await api("/api/tasks");
  if (status !== 401) fail(`status ${String(status)}`);
  return "401";
});

await step("token from the local issuer", async () => {
  const response = await fetch(`${issuerUrl}/protocol/openid-connect/token`, { method: "POST" });
  token = ((await response.json()) as { access_token: string }).access_token;
  const [header, claims] = token
    .split(".")
    .slice(0, 2)
    .map(
      (part) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>,
    );
  return `${String(header?.alg)}, typ ${String(claims?.typ)}, azp ${String(claims?.azp)}, aud ${String(claims?.aud)}`;
});

await step("hello gives welcome", async () => {
  socket = await connect(wsUrl);
  socket.send({ type: "hello", v: 1, token });
  headSeq = (await socket.next("welcome")).headSeq as number;
  return `headSeq ${String(headSeq)}`;
});

await step("subscribe tasks gives subscribed", async () => {
  socket.send({ type: "subscribe", topics: ["tasks"] });
  fromSeq = (await socket.next("subscribed")).fromSeq as number;
  if (fromSeq < headSeq + 1)
    fail(`fromSeq ${String(fromSeq)} is not after headSeq ${String(headSeq)}`);
  return `fromSeq ${String(fromSeq)}`;
});

await step("snapshot GET /api/tasks after subscribed", async () => {
  const { status, body } = await api("/api/tasks", { headers: auth() });
  if (status !== 200) fail(`status ${String(status)} ${JSON.stringify(body)}`);
  return `${String((body as TaskList).items.length)} tasks, headSeq ${String((body as TaskList).headSeq)}`;
});

await step("POST /api/tasks with an Idempotency-Key", async () => {
  taskId = taskIdOf(await submit(key, "e2e first task"));
  return `202, taskId ${taskId}`;
});

await step("notice with the same commandId", async () => {
  const notice = await socket.until("notice", () =>
    socket.notices().find((item) => item.commandId === key),
  );
  if (notice.docId !== taskId || notice.topic !== "tasks") fail(JSON.stringify(notice));
  if (notice.seq < fromSeq) fail(`seq ${String(notice.seq)} is before fromSeq ${String(fromSeq)}`);
  return `seq ${String(notice.seq)}, rev ${String(notice.rev)}`;
});

await step("GET /api/tasks shows the task", async () => {
  const { status, body } = await api("/api/tasks", { headers: auth() });
  const list = body as TaskList;
  if (status !== 200 || !list.items.some((item) => item.taskId === taskId)) {
    fail(`status ${String(status)} ${JSON.stringify(body)}`);
  }
  return `found, headSeq ${String(list.headSeq)}`;
});

await step("same Idempotency-Key gives the same taskId", async () => {
  const again = taskIdOf(await submit(key, "e2e first task"));
  if (again !== taskId) fail(`taskId ${again}, expected ${taskId}`);
  return "same taskId";
});

await step("no second notice for the same command", async () => {
  await delay(quietMs);
  const count = socket.notices().filter((item) => item.commandId === key).length;
  if (count !== 1) fail(`${String(count)} notices`);
  lastSeq = Math.max(...socket.notices().map((item) => item.seq));
  await socket.close();
  return `1 notice in ${String(quietMs)} ms, socket closed at lastSeq ${String(lastSeq)}`;
});

await step("two tasks while the socket is closed", async () => {
  for (const [index, offlineKey] of offlineKeys.entries()) {
    offlineTasks.push(taskIdOf(await submit(offlineKey, `e2e offline task ${String(index + 1)}`)));
  }
  return offlineTasks.join(", ");
});

await step("reconnect with lastSeq resumes at lastSeq + 1", async () => {
  socket = await connect(wsUrl);
  socket.send({ type: "hello", v: 1, token, lastSeq });
  await socket.next("welcome");
  socket.send({ type: "subscribe", topics: ["tasks"] });
  const resumed = (await socket.next("subscribed")).fromSeq as number;
  if (socket.frames.some((frame) => frame.type === "resync")) fail("got resync");
  if (resumed !== lastSeq + 1) fail(`fromSeq ${String(resumed)}, expected ${String(lastSeq + 1)}`);
  return `fromSeq ${String(resumed)}`;
});

await step("exactly the two missed notices, once and in order", async () => {
  await socket.until("missed notices", () =>
    offlineKeys.every((offlineKey) =>
      socket.notices().some((item) => item.commandId === offlineKey),
    )
      ? true
      : undefined,
  );
  await delay(quietMs);
  const notices = socket.notices();
  const got = notices.map((item) => `${String(item.seq)}:${String(item.commandId)}`);
  const inOrder = notices.every(
    (item, index) => index === 0 || item.seq > (notices[index - 1]?.seq ?? 0),
  );
  if (
    notices.length !== 2 ||
    !inOrder ||
    (notices[0]?.seq ?? 0) <= lastSeq ||
    notices.some(
      (item, index) => item.commandId !== offlineKeys[index] || item.docId !== offlineTasks[index],
    )
  ) {
    fail(`got ${JSON.stringify(got)}`);
  }
  await socket.close();
  return `seq ${notices.map((item) => String(item.seq)).join(", ")}`;
});

const failed = rows.some((row) => row.result !== "PASS");
const width = Math.max(...rows.map((row) => row.step.length));
console.log(`${"step".padEnd(width)}  result  detail`);
console.log(`${"-".repeat(width)}  ------  ------`);
for (const row of rows)
  console.log(`${row.step.padEnd(width)}  ${row.result.padEnd(6)}  ${row.detail}`);
console.log(failed ? "\nE2E FAIL" : "\nE2E PASS");
process.exit(failed ? 1 : 0);
