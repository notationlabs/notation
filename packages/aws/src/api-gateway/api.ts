import * as aws from "@notation/aws.iac";
import { awsName } from "src/naming";

export class ApiGroup extends aws.AwsResourceGroup<{ name: string }> {
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
}

/**
 * Declares an HTTP API, with a default stage that deploys each change.
 * @resource
 */
export function api(rgConfig: { name: string }): ApiGroup {
  return new ApiGroup(rgConfig);
}
