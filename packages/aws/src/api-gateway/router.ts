import type { LambdaTarget } from "src/lambda/create-lambda";
import { route } from "./route";
import type { ApiGroup } from "./api";
import { AuthorizerConfig, JWTAuthorizerConfig, NO_AUTH } from "./auth";

type HttpTarget = LambdaTarget<"http" | "none">;

/**
 * Adds routes to an API. Each method takes a path and a Lambda, such as
 * `router.get("/todos", () => lambda)`.
 * @resource
 */
export function router(apiGroup: ApiGroup) {
  const createRouteCallback =
    (method: string) => (path: `/${string}`, target: HttpTarget) => {
      route(apiGroup, method, path, NO_AUTH, target);
    };

  return {
    get: createRouteCallback("GET"),
    post: createRouteCallback("POST"),
    put: createRouteCallback("PUT"),
    patch: createRouteCallback("PATCH"),
    delete: createRouteCallback("DELETE"),
    withJWTAuthorizer: (auth: JWTAuthorizerConfig) => {
      const authorizer = new AuthorizedRouteBuilder(apiGroup);
      return authorizer.withJWTAuthorizer(auth);
    },
  };
}

class AuthorizedRouteBuilder {
  auth: AuthorizerConfig = NO_AUTH;
  apiGroup: ApiGroup;

  constructor(apiGroup: ApiGroup) {
    this.apiGroup = apiGroup;
  }

  private createJWTAuthorizedRouteCallback =
    (method: string, authorizer: JWTAuthorizerConfig) =>
    (path: `/${string}`, target: HttpTarget) => {
      route(this.apiGroup, method, path, authorizer, target);
    };

  withJWTAuthorizer(authorizer: JWTAuthorizerConfig) {
    return {
      get: this.createJWTAuthorizedRouteCallback("GET", authorizer),
      post: this.createJWTAuthorizedRouteCallback("POST", authorizer),
      put: this.createJWTAuthorizedRouteCallback("PUT", authorizer),
      patch: this.createJWTAuthorizedRouteCallback("PATCH", authorizer),
      delete: this.createJWTAuthorizedRouteCallback("DELETE", authorizer),
    };
  }
}
