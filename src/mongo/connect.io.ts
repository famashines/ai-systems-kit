import { setTimeout as sleep } from "node:timers/promises";
import { MongoClient, type Db, type MongoClientOptions } from "mongodb";
import type { CloseHook, ReadinessCheck } from "../http/server.ts";

export interface MongoOptions {
  url: string;
  database: string;
  attempts?: number;
  delayMs?: number;
  clientOptions?: MongoClientOptions;
}

export interface Mongo {
  client: MongoClient;
  db: Db;
  ready: ReadinessCheck;
  close: CloseHook;
}

export async function connectMongo(options: MongoOptions): Promise<Mongo> {
  const attempts = options.attempts ?? 10;
  for (let attempt = 1; ; attempt += 1) {
    const client = new MongoClient(options.url, options.clientOptions);
    try {
      await client.connect();
      const db = client.db(options.database);
      return {
        client,
        db,
        ready: () =>
          db.command({ ping: 1 }).then(
            () => true,
            () => false,
          ),
        close: () => client.close(),
      };
    } catch (error) {
      await client.close();
      if (attempt >= attempts) throw error;
      await sleep(options.delayMs ?? 1000);
    }
  }
}
