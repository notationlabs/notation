import { api, router } from "@notation/aws/api-gateway";
import { lambda as user } from "runtime/user";

const userApi = api({ name: "user-api-jwt" });

const userApiRouter = router(userApi).withJWTAuthorizer({
  type: "jwt",
  issuer: "https://myuseraccount.uk.auth0.com/",
  audience: ["https://auth0-jwt-authorizer"],
  scopes: [],
});

userApiRouter.get("/user", () => user);
