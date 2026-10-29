import * as aws from "@notation/aws.iac";
import * as std from "@notation/std.iac";
import { getActiveResourceCollection } from "@notation/resource";
import path from "path";
import { assertLambdaId, type NameSafe } from "./lambda-id";

export type LambdaConfig = {
  /**
   * Names the function and its role, zip, policy and log group, and keys them
   * in state. Changing it replaces the function, so keep it stable.
   *
   * Must be name-safe: 1 to 59 letters, digits, hyphens or underscores.
   */
  id: string;
  handler: string;
  code: {
    type: "file" | "zip";
    path: string;
  };
  runtime?: aws.lambda.LambdaFunctionConfig["Runtime"];
};

export class LambdaGroup extends aws.AwsResourceGroup<LambdaConfig> {
  readonly fn: aws.lambda.LambdaFunctionInstance;

  constructor(config: LambdaConfig) {
    assertLambdaId(config.id);
    assertUniqueLambdaId(config.id);
    super("Lambda", config.id, config);
    this.fn = build(this, config);
  }
}

/**
 * Declares a Lambda function. `id` must be a name-safe string literal; see
 * `NameSafe`.
 */
export const lambda = <const Id extends string>(
  config: Omit<LambdaConfig, "id"> & { id: NameSafe<Id> },
) => new LambdaGroup(config);

// IAM role names are unique regardless of case, so compare IDs in lower case
function assertUniqueLambdaId(id: string) {
  const collection = getActiveResourceCollection();
  if (!collection) return;
  const clash = collection.graph.resourceGroups.find(
    (group) =>
      group instanceof LambdaGroup &&
      group.id.toLowerCase() === id.toLowerCase(),
  );
  if (clash) {
    const existing = clash.id;
    throw new Error(
      existing === id
        ? `Duplicate lambda id "${id}": another lambda in this deployment already uses it. Give each lambda a unique id.`
        : `Duplicate lambda id "${id}": it clashes with "${existing}", because AWS IAM role names ignore case. Give each lambda a unique id.`,
    );
  }
}

const build = (functionGroup: LambdaGroup, config: LambdaConfig) => {
  const filePath = config.code.path;
  const lambdaId = config.id;

  let zipFile: std.fs.ZipFileInstance | std.fs.FileInstance;

  if (config.code.type === "file") {
    zipFile = functionGroup.add(
      new std.fs.Zip(`${lambdaId}-zip`, {
        config: { sourceFilePath: filePath },
      }),
    );
  } else {
    zipFile = functionGroup.add(
      new std.fs.File(`${lambdaId}-zip`, {
        config: { filePath },
      }),
    );
  }

  const role = functionGroup.add(
    new aws.lambda.LambdaIamRole(`${lambdaId}-role`, {
      config: {
        RoleName: `${lambdaId}-role`,
      },
    }),
  );

  functionGroup.add(
    new aws.lambda.LambdaRolePolicyAttachment(`${lambdaId}-policy`, {
      dependencies: { role },
    }),
  );

  const fileName = path.parse(filePath).name;
  const runtime = config.runtime || "nodejs22.x";

  const lambdaResource = functionGroup.add(
    new aws.lambda.LambdaFunction(lambdaId, {
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
    new aws.lambda.LambdaLogGroup(`${lambdaId}-log-group`, {
      config: { retentionInDays: 30 },
      dependencies: { lambda: lambdaResource },
    }),
  );

  return lambdaResource;
};
