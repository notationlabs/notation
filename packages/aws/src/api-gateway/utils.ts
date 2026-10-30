import { createHash } from "node:crypto";
import { AuthorizerConfig, JWTAuthorizerConfig } from "./auth";

// routes with the same issuer and audience share one authorizer
export const authorizerKey = (config: JWTAuthorizerConfig) =>
  createHash("sha256")
    .update(JSON.stringify([config.issuer, config.audience]))
    .digest("hex")
    .slice(0, 8);

export const mapAuthConfig = (apiId: string, config: JWTAuthorizerConfig) => {
  const jwtType: "JWT" = "JWT";

  return {
    Name: `${apiId}_jwt_${authorizerKey(config)}`,
    AuthorizerType: jwtType,
    IdentitySource: ["$request.header.Authorization"],
    JwtConfiguration: {
      Audience: config.audience,
      Issuer: config.issuer,
    },
  };
};

export const mapAuthType = (config: AuthorizerConfig) => {
  return config?.type === "jwt" ? "JWT" : "NONE";
};
