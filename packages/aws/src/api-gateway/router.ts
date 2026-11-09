import type { HttpMethod } from "src/lambda/declaration";
import { route, type ApiGatewayTarget } from "./route";
import type { ApiGroup } from "./api";
import type { JwtAuthorizerGroup } from "./auth";

type Routes<A extends JwtAuthorizerGroup<any> | undefined> = {
  [M in Lowercase<HttpMethod>]: (
    path: `/${string}`,
    target: ApiGatewayTarget<A>,
  ) => void;
};

function routes<A extends JwtAuthorizerGroup<any> | undefined>(
  apiGroup: ApiGroup,
  auth: A,
): Routes<A> {
  const add = (method: HttpMethod) => (path: `/${string}`, target: any) =>
    route(apiGroup, method, path, auth, target);
  return {
    get: add("GET"),
    post: add("POST"),
    put: add("PUT"),
    patch: add("PATCH"),
    delete: add("DELETE"),
  };
}

/**
 * Adds routes to an API. Each method takes a path and a Lambda, such as
 * `router.get("/todos", () => lambda)`. `withAuthorizer(authorizer)` returns
 * the same methods for routes that the authorizer guards.
 * @resource
 */
export function router(apiGroup: ApiGroup) {
  return {
    ...routes(apiGroup, undefined),
    withAuthorizer<A extends JwtAuthorizerGroup<any>>(
      authorizer: A,
    ): Routes<A> {
      if (authorizer.api !== apiGroup) {
        throw new Error(
          `withAuthorizer() takes an authorizer of the API "${apiGroup.id}", but the authorizer is on the API "${authorizer.api.id}".`,
        );
      }
      return routes(apiGroup, authorizer);
    },
  };
}
