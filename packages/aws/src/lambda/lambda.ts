import * as aws from "@notation/aws.iac";
import * as std from "@notation/std.iac";
import crypto from "crypto";
import type { ResourceCollector } from "@notation/core";

export const lambda = (
  collector: ResourceCollector,
  config: { fileName: string; handler: string },
) => {
  const functionGroup = new aws.AwsResourceGroup("Lambda", { config, collector });
  const filePathHash = crypto
    .createHash("BLAKE2s256")
    .update(config.fileName)
    .digest("hex")
    .slice(0, 8);

  const lambdaId = `${config.handler}-${filePathHash}`;

  const zipFile = functionGroup.add(
    new std.fs.Zip({
      id: `${lambdaId}-zip`,
      config: { filePath: config.fileName },
    }),
  );

  const role = functionGroup.add(
    new aws.lambda.LambdaIamRole({
      id: `${lambdaId}-role`,
      config: {
        RoleName: `${lambdaId}-role`,
      },
    }),
  );

  functionGroup.add(
    new aws.lambda.LambdaRolePolicyAttachment({
      id: `${lambdaId}-policy`,
      dependencies: { role },
    }),
  );

  const lambdaResource = functionGroup.add(
    new aws.lambda.LambdaFunction({
      id: lambdaId,
      config: {
        FunctionName: lambdaId,
        Handler: `index.${config.handler}`,
        Runtime: "nodejs18.x",
        ReservedConcurrentExecutions: 1,
      },
      dependencies: {
        role,
        zipFile,
      },
    }),
  );

  functionGroup.add(
    new aws.lambda.LambdaLogGroup({
      id: `${lambdaId}-log-group`,
      config: { retentionInDays: 30 },
      dependencies: { lambda: lambdaResource },
    }),
  );

  return functionGroup;
};
