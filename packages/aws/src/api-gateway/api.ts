import * as aws from "src/resources";
import { AwsResourceGroup } from "src/resource-group";
import type { ApiGatewayRoute, ApiSource } from "src/lambda/declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import { assertId, assertName, resourceId, type NameSafe } from "src/id";
import { claimedAwsName, describeDeclaration } from "src/naming";
import { isJwtAuthorizerGroup } from "./auth";
import { RouteGroup } from "./route";

export type ApiConfig = {
  /**
   * Keys the API in state. Without `name`, deploy generates the API's name in
   * AWS from the app, the stage and the id. Changing the id replaces the API,
   * so keep it stable. Must be name-safe: 1 to 64 letters, digits, hyphens or
   * underscores.
   */
  id: string;
  /**
   * The API's name in AWS, in place of a generated one. The API is named
   * `<app>--<stage>--<name>`. Must be name-safe.
   */
  name?: string;
};

export class ApiGroup extends AwsResourceGroup<ApiConfig> implements ApiSource {
  readonly api: aws.apiGateway.ApiInstance;

  constructor(config: ApiConfig) {
    assertId("api()", config.id);
    assertName("api()", config.name);
    super("API Gateway", config.id, config);
    // API Gateway does not keep API names unique, and the API is found by
    // its name.
    const apiName = claimedAwsName(
      "apiGatewayApi",
      "API Gateway APIs",
      config.name,
      describeDeclaration("api()", config.id, config.name),
    );

    this.api = this.add(
      new aws.apiGateway.Api(resourceId("api", config.id), {
        config: {
          Name: apiName,
          ProtocolType: "HTTP",
        },
      }),
    );

    this.add(
      new aws.apiGateway.Stage(resourceId("api", config.id, "stage"), {
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
 * Declares an HTTP API, with a default stage that deploys each change. `id`
 * must be a name-safe string literal; see `NameSafe`. In a function, the API
 * is `{}`.
 * @resource runtime:
 */
export function api<const Id extends string>(
  config: Omit<ApiConfig, "id"> & { id: NameSafe<Id> },
): ApiGroup {
  return new ApiGroup(config);
}
