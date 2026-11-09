import { api, jwtAuthorizer, router } from "@notation/aws/api-gateway";
import { lambda as profile } from "runtime/profile";
import { JWTClaims } from "shared/jwt";

export const userApi = api({ name: "user-api-jwt" });

export const userAuth = jwtAuthorizer({
  api: userApi,
  issuer: "https://myuseraccount.uk.auth0.com/",
  audience: ["https://auth0-jwt-authorizer"],
  claims: JWTClaims,
});

router(userApi)
  .withAuthorizer(userAuth)
  .get("/profile", () => profile);
