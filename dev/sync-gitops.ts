import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const gitops =
  process.env.GITOPS_DIR ?? fileURLToPath(new URL("../../../../platform/gitops", import.meta.url));
const ref = process.env.GITOPS_REF ?? "origin/main";
const dev = fileURLToPath(new URL(".", import.meta.url));
const git = (...args: string[]): string =>
  execFileSync("git", ["-C", gitops, ...args], { encoding: "utf8" });
const show = (path: string): string => git("show", `${ref}:${path}`);

const streamsDir = "kubernetes/infrastructure/nats/manifests/ai-systems-streams";
for (const file of readdirSync(`${dev}nats/streams`)) rmSync(`${dev}nats/streams/${file}`);
for (const path of git("ls-tree", "--name-only", `${ref}:${streamsDir}`).trim().split("\n")) {
  writeFileSync(`${dev}nats/streams/${path}`, show(`${streamsDir}/${path}`));
}

writeFileSync(`${dev}mongo/init.js`, show("kubernetes/ai-systems/ai-systems-mongodb/base/init.js"));

const values = parse(show("kubernetes/infrastructure/nats/values.yaml")) as {
  config: { merge: { accounts: { AISYSTEMS: unknown } } };
};
const accounts = JSON.stringify({ AISYSTEMS: values.config.merge.accounts.AISYSTEMS }, null, 2);
writeFileSync(
  `${dev}nats/accounts.conf`,
  `accounts: ${accounts.replace(/"<< (\$[A-Z_]+) >>"/g, "$1")}\n`,
);

const commit = git("rev-parse", ref).trim();
writeFileSync(`${dev}gitops-commit`, `${commit}\n`);
console.log(`synced from gitops ${commit}`);
