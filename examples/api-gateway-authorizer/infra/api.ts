import { api, router } from "@notation/aws/api-gateway";
import { getUserHandler } from "runtime/user.fn" with { type: "runtime" };
import type { JWTClaims } from "shared/jwt";

const userApi = api({ name: "user-api-jwt" });

const userApiRouter = router(userApi).withJWTAuthorizer<JWTClaims>({
  type: "jwt",
  issuer: "https://myuseraccount.uk.auth0.com/",
  audience: ["https://auth0-jwt-authorizer"],
  scopes: [],
});

userApiRouter.get("/user", getUserHandler);
