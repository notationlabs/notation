import * as aws from "@notation/aws.iac";
import * as std from "@notation/std.iac";
import { getActiveResourceCollection } from "@notation/resource";
import path from "path";
import { awsName } from "src/naming";
import { assertLambdaId, type NameSafe } from "./lambda-id";

export type LambdaConfig = {
  /**
   * Names the function and its role, zip, policy and log group, and keys them
   * in state. The function is named `<app>--<stage>--<id>` in AWS. Changing the
   * id replaces the function, so keep it stable.
   *
   * Must be name-safe: 1 to 64 letters, digits, hyphens or underscores.
   */
  id: string;
  /**
   * The export of the code that Lambda calls with every event. Defaults to
   * `handler`.
   */
  handler?: string;
  /** The bundle to deploy. */
  code: {
    type: "file" | "zip";
    path: string;
  };
  runtime?: aws.lambda.LambdaFunctionConfig["Runtime"];
  /** Seconds the function may run for each event. Lambda's default is 3. */
  timeout?: number;
  /** Megabytes of memory for the function. Lambda's default is 128. */
  memory?: number;
};

// Marks a LambdaGroup. Two installed copies of this package have different
// LambdaGroup classes, so `instanceof` can't recognise a group from the
// other copy. `Symbol.for` returns the same symbol in both.
const lambdaGroupMark = Symbol.for("@notation/aws/LambdaGroup");

export class LambdaGroup extends aws.AwsResourceGroup<LambdaConfig> {
  readonly fn: aws.lambda.LambdaFunctionInstance;
  readonly role: aws.lambda.LambdaIamRoleInstance;

  get [lambdaGroupMark]() {
    return true;
  }

  constructor(config: LambdaConfig) {
    assertLambdaId(config.id);
    assertUniqueLambdaId(config.id);
    super("Lambda", config.id, config);
    const { fn, role } = build(this, config);
    this.fn = fn;
    this.role = role;
  }

  /**
   * The role's inline policy. Its statements are collected: add one with
   * `policy.contribute({ PolicyDocument: { Statement: [statement] } })`.
   *
   * IAM rejects a policy with no statements, so the group adds the policy
   * only when code first reads `policy` to contribute to it.
   */
  get policy(): aws.lambda.LambdaRolePolicyInstance {
    return this.addOnce(aws.lambda.LambdaRolePolicy, `${this.id}-role-policy`, {
      config: {
        RoleName: this.role.config.RoleName,
        PolicyName: `${this.id}-role-policy`,
      },
      dependencies: { role: this.role },
    });
  }
}

export function isLambdaGroup(value: unknown): value is LambdaGroup {
  return (value as any)?.[lambdaGroupMark] === true;
}

/**
 * Declares a Lambda function that runs code built outside notation, such as
 * a zip file. `id` must be a name-safe string literal; see `NameSafe`. Use
 * `$lambda` for a function whose code is in the project.
 * @resource
 */
export function lambda<const Id extends string>(
  config: Omit<LambdaConfig, "id"> & { id: NameSafe<Id> },
): LambdaGroup {
  return new LambdaGroup(config);
}

// IAM role names are unique regardless of case, so compare IDs in lower case
function assertUniqueLambdaId(id: string) {
  const collection = getActiveResourceCollection();
  if (!collection) return;
  const clash = collection.graph.resourceGroups.find(
    (group) =>
      isLambdaGroup(group) && group.id.toLowerCase() === id.toLowerCase(),
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
        RoleName: awsName("iamRole", `${lambdaId}-role`),
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
        FunctionName: awsName("lambdaFunction", lambdaId),
        Handler: `${fileName}.${config.handler ?? "handler"}`,
        Runtime: runtime,
        Timeout: config.timeout,
        MemorySize: config.memory,
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

  return { fn: lambdaResource, role };
};
