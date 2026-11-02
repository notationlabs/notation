import * as aws from "@notation/aws.iac";
import { resolveLambdaTarget, type LambdaTarget } from "src/lambda";
import type { ApiGroup } from "./api";
import { AuthorizerConfig } from "./auth";
import { authorizerKey, mapAuthConfig, mapAuthType } from "./utils";

type RouteGroupConfig = {
  apiGroup: ApiGroup;
  method: string;
  path: `/${string}`;
  auth: AuthorizerConfig;
  handler: LambdaTarget<unknown>;
};

export class RouteGroup extends aws.AwsResourceGroup {
  readonly route: aws.apiGateway.RouteInstance;

  constructor({ apiGroup, method, path, auth, handler }: RouteGroupConfig) {
    const apiResource = apiGroup.api;
    const routeId = `${apiResource.id}-${method}-${path}`;
    const routeKey = `${method} ${path}`;
    const target = resolveLambdaTarget(handler, "route()");
    super("API Gateway/Route", routeId);

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
 * Routes requests for `method` and `path` on the API to an export of a
 * runtime module, or to a Lambda group from `lambda()`.
 */
export const route = (
  apiGroup: ApiGroup,
  method: string, // todo: http methods only
  path: `/${string}`,
  auth: AuthorizerConfig,
  handler: LambdaTarget<unknown>,
) => {
  return new RouteGroup({ apiGroup, method, path, auth, handler });
};
