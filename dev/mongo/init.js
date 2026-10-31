const host = process.env.MONGODB_HOST;
const uri = `mongodb://root:${encodeURIComponent(process.env.ROOT_PASSWORD)}@${host}/admin?directConnection=true`;

for (let i = 1; ; i++) {
  try {
    db = connect(uri);
    break;
  } catch (e) {
    if (i >= 60) throw e;
    sleep(2000);
  }
}

try {
  rs.status();
} catch (e) {
  if (e.codeName !== "NotYetInitialized") throw e;
  rs.initiate({ _id: "rs0", members: [{ _id: 0, host }] });
}
while (!db.hello().isWritablePrimary) sleep(1000);

const auditDb = db.getSiblingDB("audit_trace");
const full = ["find", "insert", "update", "remove", "createIndex", "dropIndex", "listIndexes", "createCollection", "collStats", "killCursors", "changeStream"];
const auditRole = {
  privileges: [
    { resource: { db: "audit_trace", collection: "audit" }, actions: ["find", "insert", "listIndexes", "collStats", "killCursors"] },
    ...["spans", "processed", "migrations"].map((c) => ({ resource: { db: "audit_trace", collection: c }, actions: full })),
    { resource: { db: "audit_trace", collection: "" }, actions: ["listCollections", "dbStats"] },
  ],
  roles: [],
};
if (!auditDb.getCollectionNames().includes("audit")) auditDb.createCollection("audit");
auditDb.audit.createIndex({ eventId: 1 }, { unique: true });
auditDb.audit.createIndex({ correlationId: 1, occurredAt: 1 });

if (auditDb.getRole("auditTrace")) auditDb.updateRole("auditTrace", auditRole);
else auditDb.createRole({ role: "auditTrace", ...auditRole });

const users = ["orchestration", "projections", "conversation_hub", "ai_proxy", "budget", "agent_manager", "prompt_studio", "notification", "audit_trace"];
for (const name of users) {
  const pwd = process.env[`${name.toUpperCase()}_PASSWORD`];
  if (!pwd) throw new Error(`no password for ${name}`);
  const roles = name === "audit_trace" ? [{ role: "auditTrace", db: name }] : [{ role: "readWrite", db: name }];
  const userDb = db.getSiblingDB(name);
  if (userDb.getUser(name)) userDb.updateUser(name, { pwd, roles });
  else userDb.createUser({ user: name, pwd, roles });
  print(`user ${name} ready`);
}
