import * as aws from "@notation/aws.iac";
import { lambdaTarget, type HandlerTarget } from "src/lambda";
import type { ApiGroup } from "./api";
import { AuthorizerConfig } from "./auth";
import { authorizerKey, mapAuthConfig, mapAuthType } from "./utils";

type RouteGroupConfig = {
  apiGroup: ApiGroup;
  method: string;
  path: `/${string}`;
  auth: AuthorizerConfig;
  handler: HandlerTarget<never>;
};

export class RouteGroup extends aws.AwsResourceGroup {
  #route?: aws.apiGateway.RouteInstance;

  /**
   * The route. A route to a handler of a runtime module is added when the
   * runtime modules are linked, once the handler is known. Reading it before
   * then throws.
   */
  get route(): aws.apiGateway.RouteInstance {
    if (!this.#route) {
      throw new Error(
        `The route of ${this.id} isn't set yet. It is set when the runtime modules are linked, after infra has been evaluated.`,
      );
    }
    return this.#route;
  }

  constructor({ apiGroup, method, path, auth, handler }: RouteGroupConfig) {
    const apiResource = apiGroup.api;
    const routeId = `${apiResource.id}-${method}-${path}`;
    const routeKey = `${method} ${path}`;
    super("API Gateway/Route", routeId);

    lambdaTarget(handler, "route()").wire("api", (fn, exportName) => {
      const lambdaResource = fn.fn;

      // a lambda needs one integration and permission per api, however many
      // routes it serves
      const integration = fn.addOnce(
        aws.apiGateway.LambdaIntegration,
        `${apiResource.id}-${lambdaResource.id}-integration`,
        {
          dependencies: {
            api: apiResource,
            lambda: lambdaResource,
          },
        },
      );

      fn.addOnce(
        aws.lambda.LambdaApiGatewayV2Permission,
        `${lambdaResource.id}-${apiResource.id}-permission`,
        {
          dependencies: {
            api: apiResource,
            lambda: lambdaResource,
          },
        },
      );

      if (exportName !== undefined) {
        fn.addDispatchEntry(routeId, {
          export: exportName,
          match: { apiId: apiResource.outputValue("ApiId"), routeKey },
        });
      }

      let authorizer: aws.apiGateway.AuthInstance | undefined;

      // an api allows 10 authorizers, so routes with the same jwt config share one
      if (auth.type != "NONE") {
        authorizer = apiGroup.addOnce(
          aws.apiGateway.RouteAuth,
          `${apiResource.id}-jwt-authorizer-${authorizerKey(auth)}`,
          {
            config: mapAuthConfig(apiResource.id, auth),
            dependencies: {
              api: apiResource,
            },
          },
        );
      }

      this.#route = this.add(
        new aws.apiGateway.Route(routeId, {
          config: {
            AuthorizationScopes: auth.scopes,
            RouteKey: routeKey,
            AuthorizationType: mapAuthType(auth),
          },
          dependencies: {
            api: apiResource,
            lambdaIntegration: integration,
            auth: authorizer,
          },
        }),
      );
    });
  }
}

/**
 * Routes requests for `method` and `path` on the API to a handler of a
 * runtime module, or to a Lambda group from `lambda()`. A handler is wired
 * when the runtime modules are linked.
 */
export function route(
  apiGroup: ApiGroup,
  method: string, // todo: http methods only
  path: `/${string}`,
  auth: AuthorizerConfig,
  handler: HandlerTarget<never>,
): RouteGroup {
  return new RouteGroup({ apiGroup, method, path, auth, handler });
}
