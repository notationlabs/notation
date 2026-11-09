import * as aws from "@notation/aws.iac";
import type { ApiGatewayRoute, ApiSource } from "src/lambda/declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import { awsName } from "src/naming";
import { isJwtAuthorizerGroup } from "./auth";
import { RouteGroup } from "./route";

export class ApiGroup
  extends aws.AwsResourceGroup<{ name: string }>
  implements ApiSource
{
  readonly api: aws.apiGateway.ApiInstance;

  constructor(rgConfig: { name: string }) {
    super("API Gateway", rgConfig.name, rgConfig);

    this.api = this.add(
      new aws.apiGateway.Api(rgConfig.name, {
        config: {
          Name: awsName("apiGatewayApi", rgConfig.name),
          ProtocolType: "HTTP",
        },
      }),
    );

    this.add(
      new aws.apiGateway.Stage(`${rgConfig.name}-stage`, {
        config: { StageName: "$default", AutoDeploy: true },
        dependencies: { api: this.api },
      }),
    );
  }

  /**
   * Makes a route to a Lambda, for `apiGateway.bind(api).defineRoute()` in a
   * declaration.
   */
  "~route"(
    lambdaGroup: LambdaGroup,
    { method, path, auth }: Omit<ApiGatewayRoute, "api">,
  ): void {
    if (auth !== undefined && !isJwtAuthorizerGroup(auth)) {
      throw new Error(
        `The Lambda "${lambdaGroup.id}" routes ${method} ${path} with an auth option that is not an authorizer from jwtAuthorizer().`,
      );
    }
    if (auth && auth.api !== this) {
      throw new Error(
        `The Lambda "${lambdaGroup.id}" routes ${method} ${path} on the API "${this.id}", but its authorizer is on the API "${auth.api.id}".`,
      );
    }
    new RouteGroup({ apiGroup: this, method, path, auth, lambdaGroup });
  }
}

/**
 * Declares an HTTP API, with a default stage that deploys each change. In a
 * function, the API is `{}`.
 * @resource runtime:
 */
export function api(rgConfig: { name: string }): ApiGroup {
  return new ApiGroup(rgConfig);
}
