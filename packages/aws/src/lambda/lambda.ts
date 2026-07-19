import * as aws from "@notation/aws.iac";
import * as std from "@notation/std.iac";
import crypto from "crypto";
import path from "path";

type LambdaConfig = {
  id?: string;
  handler: string;
  code: {
    type: "file" | "zip";
    path: string;
  };
  runtime?: aws.lambda.LambdaFunctionConfig["Runtime"];
};

export const lambda = (config: LambdaConfig): aws.AwsResourceGroup => {
  const functionGroup = new aws.AwsResourceGroup("Lambda", { config });
  const filePath = config.code.path;

  let lambdaId = config.id;

  if (!lambdaId) {
    const filePathHash = crypto
      .createHash("BLAKE2s256")
      .update(filePath)
      .digest("hex")
      .slice(0, 8);

    lambdaId = `${config.handler}-${filePathHash}`;
  }

  let zipFile: std.fs.ZipFileInstance | std.fs.FileInstance;

  if (config.code.type === "file") {
    zipFile = functionGroup.add(
      new std.fs.Zip({
        id: `${lambdaId}-zip`,
        config: { sourceFilePath: filePath },
      }),
    );
  } else {
    zipFile = functionGroup.add(
      new std.fs.File({
        id: `${lambdaId}-zip`,
        config: { filePath },
      }),
    );
  }

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

  const fileName = path.parse(filePath).name;
  const runtime = config.runtime || "nodejs22.x";

  const lambdaResource = functionGroup.add(
    new aws.lambda.LambdaFunction({
      id: lambdaId,
      config: {
        FunctionName: lambdaId,
        Handler: `${fileName}.${config.handler}`,
        Runtime: runtime,
        // todo: make this configurable and remove it as a default
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
