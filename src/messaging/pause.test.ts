import assert from "node:assert/strict";
import { test } from "node:test";
import { pauser } from "./pause.ts";

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

test("a pause ends after its time and gives true", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const waiting = pauser().pause(30, true);
  t.mock.timers.tick(29);
  assert.equal(await settled(waiting), false);
  t.mock.timers.tick(1);
  assert.equal(await waiting, true);
});

test("wake ends a wakeable pause, and a wake before the pause is kept", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timing = pauser();
  const waiting = timing.pause(10_000, true);
  timing.wake();
  assert.equal(await waiting, true);
  timing.wake();
  assert.equal(await timing.pause(10_000, true), true);
});

test("wake does not end a pause that is not wakeable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timing = pauser();
  const waiting = timing.pause(40, false);
  timing.wake();
  t.mock.timers.tick(39);
  assert.equal(await settled(waiting), false);
  t.mock.timers.tick(1);
  assert.equal(await waiting, true);
});

test("stop ends all pauses with false, and later pauses end at once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timing = pauser();
  const waiting = [timing.pause(10_000, true), timing.pause(10_000, false)];
  assert.equal(timing.stopped, false);
  timing.stop();
  assert.equal(timing.stopped, true);
  assert.deepEqual(await Promise.all(waiting), [false, false]);
  assert.equal(await timing.pause(10_000, false), false);
});
