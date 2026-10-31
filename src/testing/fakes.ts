export interface FakeClock {
  now: () => Date;
  advance: (ms: number) => void;
  set: (date: Date) => void;
}

export function fakeClock(start = new Date("2026-01-01T00:00:00.000Z")): FakeClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
    set: (date) => {
      current = date.getTime();
    },
  };
}

export function fakeIds(prefix = 0): () => string {
  const head = prefix.toString(16).padStart(8, "0");
  let next = 0;
  return () => {
    next += 1;
    return `${head}-0000-4000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  everyMs = 50,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end)
      throw new Error(`The condition was not true after ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
