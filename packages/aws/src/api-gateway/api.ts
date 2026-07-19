import * as aws from "@notation/aws.iac";

export const api = (rgConfig: { name: string }) => {
  const apiGroup = new aws.AwsResourceGroup("API Gateway", rgConfig);

  const apiResource = apiGroup.add(
    new aws.apiGateway.Api({
      id: rgConfig.name,
      config: {
        Name: rgConfig.name,
        ProtocolType: "HTTP",
      },
    }),
  );

  apiGroup.add(
    new aws.apiGateway.Stage({
      id: `${rgConfig.name}-stage`,
      config: { StageName: "$default", AutoDeploy: true },
      dependencies: { api: apiResource },
    }),
  );

  return apiGroup;
};
