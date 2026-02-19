import * as aws from "@notation/aws.iac";
import type { ResourceCollector } from "@notation/core";

export const api = (collector: ResourceCollector, rgConfig: { name: string }) => {
  const apiGroup = new aws.AwsResourceGroup("API Gateway", {
    ...rgConfig,
    collector,
  });

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
