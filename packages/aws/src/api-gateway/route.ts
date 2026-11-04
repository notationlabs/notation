import * as aws from "@notation/aws.iac";
import {
  wireLambdaTarget,
  type HandlerTarget,
  type ResolvedLambdaTarget,
} from "src/lambda";
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
  /**
   * The route. A route to a handler of a runtime module is added when
   * evaluation ends, once the handler is known.
   */
  route!: aws.apiGateway.RouteInstance;

  constructor(
    { apiGroup, method, path, auth, handler }: RouteGroupConfig,
    below: Function,
  ) {
    const routeId = `${apiGroup.api.id}-${method}-${path}`;
    super("API Gateway/Route", routeId);
    wireLambdaTarget(handler, "route()", ["api"], below, (target) =>
      this.#wire(target, { apiGroup, method, path, auth, routeId }),
    );
  }

  #wire(
    target: ResolvedLambdaTarget,
    {
      apiGroup,
      method,
      path,
      auth,
      routeId,
    }: Omit<RouteGroupConfig, "handler"> & { routeId: string },
  ) {
    const apiResource = apiGroup.api;
    const routeKey = `${method} ${path}`;
    const lambdaGroup = target.group;
    const lambdaResource = lambdaGroup.fn;

    // a lambda needs one integration and permission per api, however many
    // routes it serves
    const integration = lambdaGroup.addOnce(
      aws.apiGateway.LambdaIntegration,
      `${apiResource.id}-${lambdaResource.id}-integration`,
      {
        dependencies: {
          api: apiResource,
          lambda: lambdaResource,
        },
      },
    );

    lambdaGroup.addOnce(
      aws.lambda.LambdaApiGatewayV2Permission,
      `${lambdaResource.id}-${apiResource.id}-permission`,
      {
        dependencies: {
          api: apiResource,
          lambda: lambdaResource,
        },
      },
    );

    if (target.export !== undefined) {
      lambdaGroup.addDispatchEntry(routeId, {
        export: target.export,
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

    this.route = this.add(
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
  }
}

/**
 * Routes requests for `method` and `path` on the API to a handler of a
 * runtime module, or to a Lambda group from `lambda()`. A handler is wired
 * when evaluation ends.
 */
export function route(
  apiGroup: ApiGroup,
  method: string, // todo: http methods only
  path: `/${string}`,
  auth: AuthorizerConfig,
  handler: HandlerTarget<never>,
): RouteGroup {
  return new RouteGroup({ apiGroup, method, path, auth, handler }, route);
}
