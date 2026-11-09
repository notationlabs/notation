import { createHash } from "node:crypto";

type JwtConfig = { issuer: string; audience: string[] };

export const authorizerKey = (config: JwtConfig) =>
  createHash("sha256")
    .update(JSON.stringify([config.issuer, config.audience]))
    .digest("hex")
    .slice(0, 8);

export const mapAuthConfig = (apiId: string, config: JwtConfig) => ({
  Name: `${apiId}_jwt_${authorizerKey(config)}`,
  AuthorizerType: "JWT" as const,
  IdentitySource: ["$request.header.Authorization"],
  JwtConfiguration: {
    Audience: config.audience,
    Issuer: config.issuer,
  },
});
