import type {
  ApiGatewayHandler,
  JWTAuthorizedApiGatewayHandler,
} from "src/shared";
import * as aws from "@notation/aws.iac";
import type { LambdaGroup } from "src/lambda";
import type { ApiGroup } from "./api";
import { AuthorizerConfig } from "./auth";
import { mapAuthConfig, mapAuthType } from "./utils";

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
    super("API Gateway/Route", {
      dependencies: { router: apiGroup.id, fn: lambdaGroup.id },
    });

    const apiResource = apiGroup.api;
    const routeId = `${apiResource.id}-${method}-${path}`;
    const lambdaResource = lambdaGroup.fn;

    // a lambda needs one integration and permission per api, however many
    // routes it serves
    const integration = lambdaGroup.addOnce(aws.apiGateway.LambdaIntegration, {
      id: `${apiResource.id}-${lambdaResource.id}-integration`,
      dependencies: {
        api: apiResource,
        lambda: lambdaResource,
      },
    });

    lambdaGroup.addOnce(aws.lambda.LambdaApiGatewayV2Permission, {
      id: `${lambdaResource.id}-${apiResource.id}-permission`,
      dependencies: {
        api: apiResource,
        lambda: lambdaResource,
      },
    });

    let authorizer: aws.apiGateway.AuthInstance | undefined;

    if (auth.type != "NONE") {
      authorizer = this.add(
        new aws.apiGateway.RouteAuth({
          id: `${routeId}-${apiResource.id}-authorizer`,
          config: mapAuthConfig(apiResource.id, method, path, auth),
          dependencies: {
            api: apiResource,
          },
        }),
      );
    }

    this.route = this.add(
      new aws.apiGateway.Route({
        id: routeId,
        config: {
          AuthorizationScopes: auth.scopes,
          RouteKey: `${method} ${path}`,
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

export const route = (
  apiGroup: ApiGroup,
  method: string, // todo: http methods only
  path: `/${string}`,
  auth: AuthorizerConfig,
  handler:
    ApiGatewayHandler | JWTAuthorizedApiGatewayHandler<any> | LambdaGroup,
) =>
  new RouteGroup({
    apiGroup,
    method,
    path,
    auth,
    // at compile time, a runtime handler import becomes a lambda group
    lambdaGroup: handler as LambdaGroup,
  });
