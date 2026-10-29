import * as aws from "@notation/aws.iac";

export class ApiGroup extends aws.AwsResourceGroup<{ name: string }> {
  readonly api: aws.apiGateway.ApiInstance;

  constructor(rgConfig: { name: string }) {
    super("API Gateway", rgConfig.name, rgConfig);

    this.api = this.add(
      new aws.apiGateway.Api(rgConfig.name, {
        config: {
          Name: rgConfig.name,
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

export const api = (rgConfig: { name: string }) => new ApiGroup(rgConfig);
