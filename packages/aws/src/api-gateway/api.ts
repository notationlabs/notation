import * as aws from "@notation/aws.iac";

export class ApiGroup extends aws.AwsResourceGroup<{ name: string }> {
  readonly api: aws.apiGateway.ApiInstance;

  constructor(rgConfig: { name: string }) {
    super("API Gateway", { id: rgConfig.name, config: rgConfig });

    this.api = this.add(
      new aws.apiGateway.Api({
        id: rgConfig.name,
        config: {
          Name: rgConfig.name,
          ProtocolType: "HTTP",
        },
      }),
    );

    this.add(
      new aws.apiGateway.Stage({
        id: `${rgConfig.name}-stage`,
        config: { StageName: "$default", AutoDeploy: true },
        dependencies: { api: this.api },
      }),
    );
  }
}

export const api = (rgConfig: { name: string }) => new ApiGroup(rgConfig);
