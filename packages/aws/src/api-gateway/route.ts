import * as aws from "@notation/aws.iac";
import {
  resolveLambda,
  whenLoaded,
  type LambdaTarget,
} from "src/lambda/lambda-declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import type { ApiGroup } from "./api";
import { AuthorizerConfig } from "./auth";
import { authorizerKey, mapAuthConfig, mapAuthType } from "./utils";

type RouteGroupConfig = {
  apiGroup: ApiGroup;
  method: string;
  path: `/${string}`;
  auth: AuthorizerConfig;
  lambdaGroup: LambdaGroup;
};

export class RouteGroup extends aws.AwsResourceGroup {
  readonly route: aws.apiGateway.RouteInstance;

  constructor({ apiGroup, method, path, auth, lambdaGroup }: RouteGroupConfig) {
    const apiResource = apiGroup.api;
    const routeId = `${apiResource.id}-${method}-${path}`;
    const routeKey = `${method} ${path}`;
    super("API Gateway/Route", routeId);

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
 * Routes requests for `method` and `path` on the API to a Lambda: a
 * declaration from `$lambda`, passed as `() => lambda`, or a Lambda
 * group from `lambda()`. The route is made when infra has finished loading.
 * @resource
 */
export function route(
  apiGroup: ApiGroup,
  method: string, // todo: http methods only
  path: `/${string}`,
  auth: AuthorizerConfig,
  target: LambdaTarget<"http" | "none">,
): void {
  whenLoaded(() => {
    const lambdaGroup = resolveLambda(target, "route()", ["http", "none"]);
    new RouteGroup({ apiGroup, method, path, auth, lambdaGroup });
  });
}
