export interface Pauser {
  pause(ms: number, wakeable: boolean): Promise<void>;
  wake(): void;
  stop(): void;
  readonly stopped: boolean;
}

export function pauser(): Pauser {
  let stopped = false;
  let woken = false;
  const waiting = new Set<() => void>();
  const wakeable = new Set<() => void>();
  return {
    pause: (ms, canWake) =>
      new Promise<void>((resolve) => {
        if (stopped || (canWake && woken)) {
          woken = false;
          resolve();
          return;
        }
        const done = (): void => {
          clearTimeout(timer);
          waiting.delete(done);
          wakeable.delete(done);
          woken = false;
          resolve();
        };
        const timer = setTimeout(done, ms);
        waiting.add(done);
        if (canWake) wakeable.add(done);
      }),
    wake: () => {
      woken = true;
      for (const done of wakeable) done();
    },
    stop: () => {
      stopped = true;
      for (const done of waiting) done();
    },
    get stopped() {
      return stopped;
    },
  };
}
