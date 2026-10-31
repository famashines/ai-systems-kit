import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import {
  exportJWK,
  exportSPKI,
  generateKeyPair,
  SignJWT,
  UnsecuredJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import { pino } from "pino";
import { DomainError } from "../http/errors.ts";
import { createService, type Service } from "../http/server.ts";
import {
  bearerHook,
  createJwtVerifier,
  maxTokenLength,
  subjectOf,
  type JwtVerifierOptions,
} from "./index.ts";

const issuer = "https://auth.example.test/realms/ai-systems";
const audience = "ai-systems-app";

interface Key {
  kid: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: JWK;
}

const makeKey = async (kid: string): Promise<Key> => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  return {
    kid,
    privateKey,
    publicKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
  };
};

let first: Key;
let second: Key;
let stranger: Key;
let published: JWK[] = [];
let jwksStatus = 200;
let fetches = 0;
let jwks: Server;
let jwksUrl: string;

before(async () => {
  [first, second, stranger] = await Promise.all([makeKey("k1"), makeKey("k2"), makeKey("k9")]);
  jwks = createServer((_request, response) => {
    fetches += 1;
    response
      .writeHead(jwksStatus, { "content-type": "application/json" })
      .end(JSON.stringify({ keys: published }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  jwksUrl = `http://127.0.0.1:${String((jwks.address() as AddressInfo).port)}/certs`;
});

after(async () => {
  await new Promise((resolve) => jwks.close(resolve));
});

const fresh = (options: Partial<JwtVerifierOptions> = {}) => {
  published = [first.jwk];
  jwksStatus = 200;
  fetches = 0;
  return createJwtVerifier({ issuer, audience, requiredRole: "owner", jwksUrl, ...options });
};

const now = (): number => Math.floor(Date.now() / 1000);

const sign = (claims: Record<string, unknown> = {}, key: Key = first): Promise<string> =>
  new SignJWT({
    iss: issuer,
    aud: [audience, "account"],
    sub: "owner-1",
    iat: now(),
    exp: now() + 300,
    typ: "Bearer",
    realm_access: { roles: ["owner", "default-roles-ai-systems"] },
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
    .sign(key.privateKey);

const fails = async (work: Promise<unknown>, status: number, error?: string) => {
  await assert.rejects(work, (thrown: unknown) => {
    assert.ok(thrown instanceof DomainError);
    assert.equal(thrown.status, status);
    if (error)
      assert.match(thrown.headers["www-authenticate"] ?? "", new RegExp(`error="${error}"`));
    return true;
  });
};

describe("createJwtVerifier", () => {
  test("a valid token gives the subject", async () => {
    const verify = fresh();
    const token = await sign();
    const subject = await verify(token);
    assert.equal(subject.sub, "owner-1");
    assert.deepEqual(subject.roles, ["owner", "default-roles-ai-systems"]);
    assert.equal(subject.exp, now() + 300);
    await verify(token);
    assert.equal(fetches, 1);
  });

  test("the default JWKS URL is the Keycloak certs path of the issuer", async () => {
    const own = jwksUrl.replace(/\/certs$/, "/realms/ai-systems");
    fresh();
    const verify = createJwtVerifier({ issuer: own, audience, requiredRole: "owner" });
    const seen = new Promise<string | undefined>((resolve) => {
      jwks.once("request", (request: { url?: string }) => {
        resolve(request.url);
      });
    });
    await verify(await sign({ iss: own }));
    assert.equal(await seen, "/realms/ai-systems/protocol/openid-connect/certs");
  });

  test("an expired token gives 401; inside the clock tolerance it passes", async () => {
    const verify = fresh();
    await fails(verify(await sign({ exp: now() - 31, iat: now() - 400 })), 401, "invalid_token");
    await verify(await sign({ exp: now() - 20, iat: now() - 400 }));
  });

  test("nbf and iat in the future give 401", async () => {
    const verify = fresh();
    await fails(verify(await sign({ nbf: now() + 60 })), 401, "invalid_token");
    await fails(verify(await sign({ iat: now() + 60 })), 401, "invalid_token");
    await verify(await sign({ iat: now() + 20, nbf: now() + 20 }));
  });

  test("a wrong issuer or audience gives 401", async () => {
    const verify = fresh();
    await fails(verify(await sign({ iss: "https://evil.example.test/realms/ai-systems" })), 401);
    await fails(verify(await sign({ aud: "account" })), 401, "invalid_token");
    await fails(verify(await sign({ aud: ["other-app", "account"] })), 401);
    await verify(await sign({ aud: audience }));
  });

  test("a missing role gives 403", async () => {
    const verify = fresh();
    await fails(
      verify(await sign({ realm_access: { roles: ["default-roles-ai-systems"] } })),
      403,
      "insufficient_scope",
    );
    await fails(verify(await sign({ realm_access: undefined })), 403);
    await fails(
      verify(
        await sign({
          resource_access: { account: { roles: ["owner"] } },
          realm_access: { roles: [] },
        }),
      ),
      403,
    );
  });

  test("a token that is not an access token gives 401", async () => {
    const verify = fresh();
    await fails(verify(await sign({ typ: "ID" })), 401, "invalid_token");
    await fails(verify(await sign({ sub: undefined })), 401, "invalid_token");
    await fails(verify(await sign({ sub: "x".repeat(201) })), 401);
    await fails(verify(await sign({ realm_access: { roles: "owner" } })), 401);
  });

  test("alg none gives 401", async () => {
    const verify = fresh();
    const token = new UnsecuredJWT({
      iss: issuer,
      aud: audience,
      sub: "owner-1",
      iat: now(),
      exp: now() + 300,
      typ: "Bearer",
      realm_access: { roles: ["owner"] },
    }).encode();
    await fails(verify(token), 401, "invalid_token");
    await fails(verify(`${token.split(".").slice(0, 2).join(".")}.c2ln`), 401);
  });

  test("HS256 with the public key as the secret gives 401", async () => {
    const verify = fresh();
    const secret = new TextEncoder().encode(await exportSPKI(first.publicKey));
    const token = await new SignJWT({
      iss: issuer,
      aud: audience,
      sub: "owner-1",
      iat: now(),
      exp: now() + 300,
      typ: "Bearer",
      realm_access: { roles: ["owner"] },
    })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .sign(secret);
    await fails(verify(token), 401, "invalid_token");
    assert.equal(fetches, 0);
  });

  test("a bad signature or a token that is not a JWT gives 401", async () => {
    const verify = fresh();
    const [header, payload] = (await sign()).split(".");
    const other = (await sign({}, stranger)).split(".")[2];
    await fails(verify(`${header ?? ""}.${payload ?? ""}.${other ?? ""}`), 401, "invalid_token");
    await fails(verify("not-a-token"), 401, "invalid_token");
    await fails(verify("x".repeat(maxTokenLength + 1)), 401, "invalid_token");
  });

  test("an unknown key: the JWKS is fetched again once, then 401; a second one waits for the cooldown", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const verify = fresh();
    await verify(await sign());
    assert.equal(fetches, 1);
    t.mock.timers.tick(31_000);
    await fails(verify(await sign({}, stranger)), 401, "invalid_token");
    assert.equal(fetches, 2);
    await fails(verify(await sign({}, stranger)), 401);
    assert.equal(fetches, 2);
  });

  test("a key rotation: a token of the new key passes, the old key goes after the cache age", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const verify = fresh();
    const old = await sign();
    await verify(old);
    published = [first.jwk, second.jwk];
    t.mock.timers.tick(31_000);
    await verify(await sign({}, second));
    assert.equal(fetches, 2);
    published = [second.jwk];
    t.mock.timers.tick(10 * 60_000);
    await fails(verify(await sign()), 401, "invalid_token");
    await verify(await sign({}, second));
    assert.equal(fetches, 3);
  });

  test("a JWKS that cannot be read gives 503, and the next call tries again", async () => {
    const verify = fresh();
    jwksStatus = 500;
    await fails(verify(await sign()), 503);
    jwksStatus = 200;
    await verify(await sign());
    assert.equal(fetches, 2);
    const down = createJwtVerifier({
      issuer,
      audience,
      requiredRole: "owner",
      jwksUrl: "http://127.0.0.1:1/certs",
    });
    await fails(down(await sign()), 503);
  });
});

describe("bearerHook", () => {
  const services: Service[] = [];
  after(async () => {
    await Promise.all(services.map((service) => service.close()));
  });

  const start = async () => {
    const verify = fresh();
    const service = createService({
      logger: pino({ level: "silent" }),
      drainDelayMs: 0,
      before: [bearerHook(verify)],
      routes: [
        {
          method: "GET",
          path: "/api/me",
          handler: (request) => ({ body: subjectOf(request) }),
        },
      ],
    });
    services.push(service);
    const { port } = await service.listen(0, "127.0.0.1");
    return (path: string, authorization?: string) =>
      fetch(`http://127.0.0.1:${String(port)}${path}`, {
        headers: authorization === undefined ? {} : { authorization },
      });
  };

  test("a valid bearer token puts the subject in request.state", async () => {
    const call = await start();
    const response = await call("/api/me", `Bearer ${await sign()}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { sub: string; roles: string[] };
    assert.equal(body.sub, "owner-1");
    assert.ok(body.roles.includes("owner"));
  });

  test("no token, another scheme or a bad form gives 401 before routing", async () => {
    const call = await start();
    const token = await sign();
    const cases: [string | undefined, string][] = [
      [undefined, 'Bearer realm="ai-systems"'],
      [`Basic ${Buffer.from("a:b").toString("base64")}`, 'Bearer realm="ai-systems"'],
      [`bearer ${token}`, 'Bearer realm="ai-systems"'],
      [`Bearer  ${token}`, 'Bearer realm="ai-systems", error="invalid_token"'],
      [`Bearer ${token} x`, 'Bearer realm="ai-systems", error="invalid_token"'],
      [`Bearer ${"a".repeat(maxTokenLength)}`, 'Bearer realm="ai-systems", error="invalid_token"'],
      ["Bearer", 'Bearer realm="ai-systems"'],
      ["Bearer a%b", 'Bearer realm="ai-systems", error="invalid_token"'],
    ];
    for (const [authorization, challenge] of cases) {
      for (const path of ["/api/me", "/api/unknown"]) {
        const response = await call(path, authorization);
        assert.equal(response.status, 401, `${String(authorization).slice(0, 20)} ${path}`);
        assert.equal(response.headers.get("www-authenticate"), challenge);
        const problem = (await response.json()) as { code: string };
        assert.equal(problem.code, "unauthorized");
      }
    }
    assert.equal(fetches, 0);
  });

  test("a valid token on an unknown path gives 404, and health stays open", async () => {
    const call = await start();
    assert.equal((await call("/api/unknown", `Bearer ${await sign()}`)).status, 404);
    assert.equal((await call("/health")).status, 200);
  });

  test("a token with no role gives 403", async () => {
    const call = await start();
    const token = await sign({ realm_access: { roles: [] } });
    const response = await call("/api/me", `Bearer ${token}`);
    assert.equal(response.status, 403);
    assert.equal(
      response.headers.get("www-authenticate"),
      'Bearer realm="ai-systems", error="insufficient_scope"',
    );
  });

  test("subjectOf with no hook gives 401", () => {
    assert.throws(
      () => subjectOf({ state: {} } as unknown as Parameters<typeof subjectOf>[0]),
      (error: unknown) => error instanceof DomainError && error.status === 401,
    );
  });
});
