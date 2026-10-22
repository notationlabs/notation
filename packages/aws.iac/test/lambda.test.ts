import { afterEach, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-lambda";
import { lambdaClient } from "src/utils/aws-clients";
import { LambdaFunction } from "src/resources/lambda/lambda";

afterEach(() => {
  vi.restoreAllMocks();
});

it("reads VPC and SnapStart config in the shape they are configured in", async () => {
  const response: sdk.GetFunctionResponse = {
    Configuration: {
      FunctionName: "app",
      State: "Active",
      RevisionId: "rev-1",
      VpcConfig: {
        SubnetIds: ["subnet-1"],
        SecurityGroupIds: ["sg-1"],
        VpcId: "vpc-1",
        Ipv6AllowedForDualStack: false,
      },
      SnapStart: { ApplyOn: "PublishedVersions", OptimizationStatus: "On" },
    },
  };
  vi.spyOn(lambdaClient, "send").mockImplementation(async (command) => {
    if (command instanceof sdk.GetFunctionCommand) return response;
    throw new Error("unexpected command");
  });

  const lambda = new LambdaFunction({
    id: "app",
    config: {} as any,
    dependencies: {} as any,
  });
  const result = (await lambda.read!(
    { FunctionName: "app" },
    {} as any,
  )) as Record<string, unknown>;

  expect(result.VpcConfig).toEqual({
    SubnetIds: ["subnet-1"],
    SecurityGroupIds: ["sg-1"],
    Ipv6AllowedForDualStack: false,
  });
  expect(result.SnapStart).toEqual({ ApplyOn: "PublishedVersions" });
});
