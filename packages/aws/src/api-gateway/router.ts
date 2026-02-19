import type {
  ApiGatewayHandler,
  JWTAuthorizedApiGatewayHandler,
} from "src/shared";
import { route } from "./route";
import { api } from "./api";
import { AuthorizerConfig, JWTAuthorizerConfig, NO_AUTH } from "./auth";
import type { ResourceCollector } from "@notation/core";

export const router = (
  collector: ResourceCollector,
  apiGroup: ReturnType<typeof api>,
) => {
  const createRouteCallback =
    (method: string) => (path: `/${string}`, handler: ApiGatewayHandler) => {
      return route(collector, apiGroup, method, path, NO_AUTH, handler);
    };

  return {
    get: createRouteCallback("GET"),
    post: createRouteCallback("POST"),
    put: createRouteCallback("PUT"),
    patch: createRouteCallback("PATCH"),
    delete: createRouteCallback("DELETE"),
    withJWTAuthorizer: <ClaimsType>(auth: JWTAuthorizerConfig) => {
      const authorizer = new AuthorizedRouteBuilder(collector, apiGroup);
      return authorizer.withJWTAuthorizer<ClaimsType>(auth);
    },
  };
};

class AuthorizedRouteBuilder {
  auth: AuthorizerConfig = NO_AUTH;
  apiGroup: ReturnType<typeof api>;
  collector: ResourceCollector;

  constructor(collector: ResourceCollector, apiGroup: ReturnType<typeof api>) {
    this.collector = collector;
    this.apiGroup = apiGroup;
  }

  private createJWTAuthorizedRouteCallback =
    <ClaimsType>(method: string, authorizer: JWTAuthorizerConfig) =>
    (
      path: `/${string}`,
      handler: JWTAuthorizedApiGatewayHandler<ClaimsType>,
    ) => {
      return route(this.collector, this.apiGroup, method, path, authorizer, handler);
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
