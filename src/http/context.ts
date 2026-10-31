import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const getContext = (): RequestContext | undefined => storage.getStore();

export const runWithContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);
