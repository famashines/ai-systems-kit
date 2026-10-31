import assert from "node:assert/strict";
import { test } from "node:test";
import { pauser } from "./pause.ts";

const timed = async (work: Promise<void>): Promise<number> => {
  const start = performance.now();
  await work;
  return performance.now() - start;
};

test("a pause ends after its time", async () => {
  assert.ok((await timed(pauser().pause(30, true))) >= 25);
});

test("wake ends a wakeable pause, and a wake before the pause is kept", async () => {
  const timing = pauser();
  const waiting = timing.pause(10_000, true);
  timing.wake();
  assert.ok((await timed(waiting)) < 1000);
  timing.wake();
  assert.ok((await timed(timing.pause(10_000, true))) < 1000);
});

test("wake does not end a pause that is not wakeable", async () => {
  const timing = pauser();
  const waiting = timing.pause(40, false);
  timing.wake();
  assert.ok((await timed(waiting)) >= 35);
});

test("stop ends all pauses, and later pauses end at once", async () => {
  const timing = pauser();
  const waiting = [timing.pause(10_000, true), timing.pause(10_000, false)];
  assert.equal(timing.stopped, false);
  timing.stop();
  assert.equal(timing.stopped, true);
  assert.ok((await timed(Promise.all(waiting).then(() => undefined))) < 1000);
  assert.ok((await timed(timing.pause(10_000, false))) < 1000);
});
