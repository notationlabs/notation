import type {
  ApiGatewayHandler,
  JWTAuthorizedApiGatewayHandler,
} from "src/shared";
import * as aws from "@notation/aws.iac";
import type { ResourceCollector } from "@notation/core";
import { api } from "./api";
import { AuthorizerConfig } from "./auth";
import { mapAuthConfig, mapAuthType } from "./utils";

export const route = (
  collector: ResourceCollector,
  apiGroup: ReturnType<typeof api>,
  method: string, // todo: http methods only
  path: `/${string}`,
  auth: AuthorizerConfig,
  handler:
    | ApiGatewayHandler
    | JWTAuthorizedApiGatewayHandler<any>
    // todo: narrow to lambda group
    | aws.AwsResourceGroup,
) => {
  const apiResource = apiGroup.findResource(aws.apiGateway.Api)!;
  const routeId = `${apiResource.id}-${method}-${path}`;

  const lambdaGroup =
    handler instanceof aws.AwsResourceGroup
      ? handler
      : // at compile time, runtime module becomes infra resource group
        (handler as any as aws.AwsResourceGroup);

  const lambdaResource = lambdaGroup.findResource(aws.lambda.LambdaFunction)!;

  let integration = lambdaGroup.findResource(aws.apiGateway.LambdaIntegration);

  if (!integration) {
    integration = lambdaGroup.add(
      new aws.apiGateway.LambdaIntegration({
        id: `${apiResource.id}-${lambdaResource.id}-integration`,
        dependencies: {
          api: apiResource,
          lambda: lambdaResource,
        },
      }),
    );
  }

  const permission = lambdaGroup.findResource(
    aws.lambda.LambdaApiGatewayV2Permission,
  );

  if (!permission) {
    lambdaGroup.add(
      new aws.lambda.LambdaApiGatewayV2Permission({
        id: `${lambdaResource.id}-${apiResource.id}-permission`,
        dependencies: {
          api: apiResource,
          lambda: lambdaResource,
        },
      }),
    );
  }

  const routeGroup = new aws.AwsResourceGroup("API Gateway/Route", {
    dependencies: { router: apiGroup.id, fn: lambdaGroup.id },
    collector,
  });

  if (auth.type != "NONE") {
    const authConfig = mapAuthConfig(apiResource.id, method, path, auth);

    const authorizer = new aws.apiGateway.RouteAuth({
      id: `${routeId}-${apiResource.id}-authorizer`,
      config: authConfig,
      dependencies: {
        api: apiResource,
      },
    });

    routeGroup.add(authorizer);
  }

  const authorizerResource = routeGroup.findResource(aws.apiGateway.RouteAuth);

  routeGroup.add(
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
        auth: authorizerResource,
      },
    }),
  );

  return routeGroup;
};
