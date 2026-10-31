import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import type { Logger } from "pino";
import { z } from "zod";
import {
  DomainError,
  ForbiddenError,
  UnauthorizedError,
  UnavailableError,
} from "../http/errors.ts";
import type { Request } from "../http/router.ts";
import type { Hook } from "../http/server.ts";

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  requiredRole: string;
  jwksUrl?: string;
  clockToleranceSec?: number;
  logger?: Logger;
}

export interface Subject {
  sub: string;
  roles: readonly string[];
  exp: number;
}

export type JwtVerifier = (token: string) => Promise<Subject>;

export const maxTokenLength = 8192;

const keySetRetryMs = 5000;

const challenge = 'Bearer realm="ai-systems"';

const invalidToken = (message: string): UnauthorizedError =>
  new UnauthorizedError(message, { "www-authenticate": `${challenge}, error="invalid_token"` });

const Claims = z.object({
  sub: z.string().min(1).max(200),
  exp: z.number(),
  iat: z.number(),
  azp: z.string(),
  typ: z.literal("Bearer"),
  realm_access: z.object({ roles: z.array(z.string()) }).optional(),
});

const keySetFailures = new Set([
  errors.JOSEError.code,
  errors.JWKSInvalid.code,
  errors.JWKSTimeout.code,
]);

const isKeySetFailure = (error: unknown): boolean =>
  !(error instanceof errors.JOSEError) || keySetFailures.has(error.code);

export function createJwtVerifier(options: JwtVerifierOptions): JwtVerifier {
  const { issuer, audience, requiredRole, clockToleranceSec = 30, logger } = options;
  const url = new URL(options.jwksUrl ?? `${issuer}/protocol/openid-connect/certs`);
  const remote = createRemoteJWKSet(url);
  let failedAt = Number.NEGATIVE_INFINITY;
  const keys: JWTVerifyGetKey = async (header, token) => {
    if (Date.now() - failedAt < keySetRetryMs) {
      const cached = remote.fresh ? remote.jwks() : undefined;
      if (!cached) throw new Error("The JWKS failed a short time ago");
      try {
        return await createLocalJWKSet(cached)(header, token);
      } catch (error) {
        throw new Error("The JWKS failed a short time ago", { cause: error });
      }
    }
    try {
      return await remote(header, token);
    } catch (error) {
      if (isKeySetFailure(error) && Date.now() - failedAt >= keySetRetryMs) {
        failedAt = Date.now();
        logger?.warn({ err: error, jwksUrl: url.href }, "the JWKS could not be read");
      }
      throw error;
    }
  };
  return async (token) => {
    if (token.length > maxTokenLength) throw invalidToken("The token is too long");
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer,
        audience,
        algorithms: ["RS256"],
        clockTolerance: clockToleranceSec,
        requiredClaims: ["sub", "exp", "iat"],
      }));
    } catch (error) {
      if (isKeySetFailure(error)) {
        throw new UnavailableError("The keys of the identity provider are not available");
      }
      throw invalidToken("The token is not valid");
    }
    const claims = Claims.safeParse(payload);
    if (!claims.success) throw invalidToken("The token is not an access token");
    const { sub, exp, iat, azp, realm_access } = claims.data;
    if (azp !== audience) throw invalidToken("The token is for another client");
    if (iat > Date.now() / 1000 + clockToleranceSec) {
      throw invalidToken("The token is issued in the future");
    }
    const roles = realm_access?.roles ?? [];
    if (!roles.includes(requiredRole)) {
      throw new ForbiddenError("The token does not have the necessary role", {
        "www-authenticate": `${challenge}, error="insufficient_scope"`,
      });
    }
    return { sub, roles, exp };
  };
}

const bearer = /^Bearer ([\w.~+/-]+=*)$/;

const hasBody = (request: Request): boolean =>
  (request.headers["content-length"] ?? "0") !== "0" ||
  request.headers["transfer-encoding"] !== undefined;

function closing(error: unknown): unknown {
  if (!(error instanceof DomainError)) return error;
  const headers = { ...error.headers, connection: "close" };
  if (error instanceof ForbiddenError) return new ForbiddenError(error.message, headers);
  if (error instanceof UnauthorizedError) return new UnauthorizedError(error.message, headers);
  return new DomainError(error.code, error.status, error.message, headers);
}

export const bearerHook =
  (verify: JwtVerifier): Hook =>
  async (request) => {
    try {
      request.state.subject = await check(verify, request);
    } catch (error) {
      throw hasBody(request) ? closing(error) : error;
    }
  };

async function check(verify: JwtVerifier, request: Request): Promise<Subject> {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ") !== true) {
    throw new UnauthorizedError("A bearer token is necessary", { "www-authenticate": challenge });
  }
  const token = header.length <= maxTokenLength ? bearer.exec(header)?.[1] : undefined;
  if (token === undefined) throw invalidToken("The authorization header is not valid");
  return verify(token);
}

export function subjectOf(request: Request): Subject {
  const subject = request.state.subject as Subject | undefined;
  if (!subject) {
    throw new UnauthorizedError("A bearer token is necessary", { "www-authenticate": challenge });
  }
  return subject;
}
