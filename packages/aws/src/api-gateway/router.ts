import type { RuntimeRef } from "src/lambda";
import { route } from "./route";
import type { ApiGroup } from "./api";
import { AuthorizerConfig, JWTAuthorizerConfig, NO_AUTH } from "./auth";

export const router = (apiGroup: ApiGroup) => {
  const createRouteCallback =
    (method: string) => (path: `/${string}`, handler: RuntimeRef) => {
      return route(apiGroup, method, path, NO_AUTH, handler);
    };

  return {
    get: createRouteCallback("GET"),
    post: createRouteCallback("POST"),
    put: createRouteCallback("PUT"),
    patch: createRouteCallback("PATCH"),
    delete: createRouteCallback("DELETE"),
    withJWTAuthorizer: <ClaimsType>(auth: JWTAuthorizerConfig) => {
      const authorizer = new AuthorizedRouteBuilder(apiGroup);
      return authorizer.withJWTAuthorizer<ClaimsType>(auth);
    },
  };
};

class AuthorizedRouteBuilder {
  auth: AuthorizerConfig = NO_AUTH;
  apiGroup: ApiGroup;

  constructor(apiGroup: ApiGroup) {
    this.apiGroup = apiGroup;
  }

  private createJWTAuthorizedRouteCallback =
    <ClaimsType>(method: string, authorizer: JWTAuthorizerConfig) =>
    (path: `/${string}`, handler: RuntimeRef) => {
      return route(this.apiGroup, method, path, authorizer, handler);
    };

  withJWTAuthorizer<ClaimsType>(authorizer: JWTAuthorizerConfig) {
    return {
      get: this.createJWTAuthorizedRouteCallback<ClaimsType>("GET", authorizer),
      post: this.createJWTAuthorizedRouteCallback<ClaimsType>(
        "POST",
        authorizer,
      ),
      put: this.createJWTAuthorizedRouteCallback<ClaimsType>("PUT", authorizer),
      patch: this.createJWTAuthorizedRouteCallback<ClaimsType>(
        "PATCH",
        authorizer,
      ),
      delete: this.createJWTAuthorizedRouteCallback<ClaimsType>(
        "DELETE",
        authorizer,
      ),
    };
  }
}
