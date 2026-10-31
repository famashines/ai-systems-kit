import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";

const issuer = process.env.ISSUER ?? "http://issuer:8080/realms/ai-systems";
const clientId = process.env.CLIENT_ID ?? "ai-systems-app";
const subject = process.env.SUBJECT ?? "4c0f3f1e-8f7a-4b6e-9d2a-1f5e7c3b9a10";
const lifetimeSec = 3600;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = randomUUID();
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }] };

const base64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

function token(): string {
  const iat = Math.floor(Date.now() / 1000);
  const body = `${base64url({ alg: "RS256", typ: "JWT", kid })}.${base64url({
    iss: issuer,
    sub: subject,
    aud: clientId,
    azp: clientId,
    typ: "Bearer",
    iat,
    exp: iat + lifetimeSec,
    jti: randomUUID(),
    realm_access: { roles: ["owner"] },
  })}`;
  return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
}

const path = new URL(issuer).pathname.replace(/\/$/, "");
const routes: Record<string, (method: string) => object | undefined> = {
  "/health": () => ({ status: "ok" }),
  [`${path}/.well-known/openid-configuration`]: () => ({
    issuer,
    jwks_uri: `${issuer}/protocol/openid-connect/certs`,
    token_endpoint: `${issuer}/protocol/openid-connect/token`,
    id_token_signing_alg_values_supported: ["RS256"],
  }),
  [`${path}/protocol/openid-connect/certs`]: () => jwks,
  [`${path}/protocol/openid-connect/token`]: (method) =>
    method === "POST"
      ? { access_token: token(), token_type: "Bearer", expires_in: lifetimeSec }
      : undefined,
};

createServer((request, response) => {
  request.resume();
  const body = routes[new URL(request.url ?? "/", "http://x").pathname]?.(request.method ?? "");
  response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify(body ?? { error: "not_found" }));
}).listen(8080, () => {
  console.log(`dev issuer ${issuer} ready`);
});

process.on("SIGTERM", () => process.exit(0));
