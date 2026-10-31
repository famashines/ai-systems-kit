import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import { ForbiddenError, UnauthorizedError, UnavailableError } from "../http/errors.ts";
import type { Request } from "../http/router.ts";
import type { Hook } from "../http/server.ts";

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  requiredRole: string;
  jwksUrl?: string;
  clockToleranceSec?: number;
}

export interface Subject {
  sub: string;
  roles: readonly string[];
  exp: number;
}

export type JwtVerifier = (token: string) => Promise<Subject>;

export const maxTokenLength = 8192;

const challenge = 'Bearer realm="ai-systems"';

const invalidToken = (message: string): UnauthorizedError =>
  new UnauthorizedError(message, { "www-authenticate": `${challenge}, error="invalid_token"` });

const Claims = z.object({
  sub: z.string().min(1).max(200),
  exp: z.number(),
  iat: z.number(),
  typ: z.literal("Bearer"),
  realm_access: z.object({ roles: z.array(z.string()) }).optional(),
});

const keySetFailures = new Set([
  errors.JOSEError.code,
  errors.JWKSInvalid.code,
  errors.JWKSTimeout.code,
]);

export function createJwtVerifier(options: JwtVerifierOptions): JwtVerifier {
  const { issuer, audience, requiredRole, clockToleranceSec = 30 } = options;
  const keys = createRemoteJWKSet(
    new URL(options.jwksUrl ?? `${issuer}/protocol/openid-connect/certs`),
  );
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
      if (!(error instanceof errors.JOSEError) || keySetFailures.has(error.code)) {
        throw new UnavailableError("The keys of the identity provider are not available");
      }
      throw invalidToken("The token is not valid");
    }
    const claims = Claims.safeParse(payload);
    if (!claims.success) throw invalidToken("The token is not an access token");
    const { sub, exp, iat, realm_access } = claims.data;
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

export const bearerHook =
  (verify: JwtVerifier): Hook =>
  async (request) => {
    const header = request.headers.authorization;
    if (header?.startsWith("Bearer ") !== true) {
      throw new UnauthorizedError("A bearer token is necessary", { "www-authenticate": challenge });
    }
    const token = header.length <= maxTokenLength ? bearer.exec(header)?.[1] : undefined;
    if (token === undefined) throw invalidToken("The authorization header is not valid");
    request.state.subject = await verify(token);
  };

export function subjectOf(request: Request): Subject {
  const subject = request.state.subject as Subject | undefined;
  if (!subject) {
    throw new UnauthorizedError("A bearer token is necessary", { "www-authenticate": challenge });
  }
  return subject;
}
