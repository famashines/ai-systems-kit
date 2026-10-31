import { MongoServerError, type Db } from "mongodb";

export interface Migration {
  name: string;
  up: (db: Db) => Promise<void>;
}

const migrationName = /^\d{3}-[a-z0-9]+(-[a-z0-9]+)*$/;

export async function runMigrations(db: Db, migrations: readonly Migration[]): Promise<string[]> {
  const sorted = migrations.toSorted((a, b) => (a.name < b.name ? -1 : 1));
  sorted.forEach((migration, index) => {
    if (!migrationName.test(migration.name)) {
      throw new Error(`The migration name ${migration.name} is not NNN-name`);
    }
    if (migration.name === sorted[index - 1]?.name) {
      throw new Error(`The migration name ${migration.name} is not unique`);
    }
  });
  const records = db.collection<{ _id: string; appliedAt: Date }>("migrations");
  const done = new Set((await records.find().toArray()).map((record) => record._id));
  const applied: string[] = [];
  for (const migration of sorted) {
    if (done.has(migration.name)) continue;
    await migration.up(db);
    try {
      await records.insertOne({ _id: migration.name, appliedAt: new Date() });
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
    }
    applied.push(migration.name);
  }
  return applied;
}
