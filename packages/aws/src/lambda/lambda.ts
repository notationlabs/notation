import * as aws from "src/resources";
import { AwsResourceGroup } from "src/resource-group";
import * as std from "@notation/std/resources";
import { isBundle, type BundleLike } from "@notation/build/resources";
import { getActiveResourceCollection } from "@notation/resource";
import path from "path";
import { assertId, resourceId, type NameSafe } from "src/id";

export type LambdaConfig = {
  /**
   * Keys the function and its role, zip, policy and log group in state.
   * Deploy generates the function's name in AWS from the app, the stage and
   * the id. Changing the id replaces the function, so keep it stable.
   *
   * Must be name-safe: 1 to 64 letters, digits, hyphens or underscores.
   */
  id: string;
  /**
   * The export of the code that Lambda calls with every event. Defaults to
   * `handler`.
   */
  handler?: string;
  /**
   * The code to deploy: a file, which deploy zips, a zip file, or a bundle
   * from `bundle()` with `platform: "node"`.
   */
  code: { type: "file" | "zip"; path: string } | BundleLike;
  runtime?: aws.lambda.LambdaFunctionConfig["Runtime"];
  /** Seconds the function may run for each event. Lambda's default is 3. */
  timeout?: number;
  /** Megabytes of memory for the function. Lambda's default is 128. */
  memory?: number;
  /**
   * The function's reserved concurrency: the most instances that may run at
   * once, set aside from the account's limit. Without it, the function uses
   * the account's unreserved concurrency. `0` stops all invocations. AWS
   * rejects a reservation that would leave the account below its minimum
   * unreserved concurrency, and the deploy fails.
   */
  concurrency?: number;
};

// Marks a LambdaGroup. Two installed copies of this package have different
// LambdaGroup classes, so `instanceof` can't recognise a group from the
// other copy. `Symbol.for` returns the same symbol in both.
const lambdaGroupMark = Symbol.for("@notation/aws/LambdaGroup");

export class LambdaGroup extends AwsResourceGroup<LambdaConfig> {
  readonly fn: aws.lambda.LambdaFunctionInstance;
  readonly role: aws.lambda.LambdaIamRoleInstance;

  get [lambdaGroupMark]() {
    return true;
  }

  /**
   * @param caller The function that declares the Lambda, such as `$lambda`,
   * for errors.
   */
  constructor(config: LambdaConfig, caller = "lambda()") {
    assertId(caller, config.id);
    assertUniqueLambdaId(caller, config.id);
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
    return this.addOnce(
      aws.lambda.LambdaRolePolicy,
      resourceId("lambda", this.id, "role-policy"),
      {
        config: {
          RoleName: this.role.outputRef("RoleName"),
          PolicyName: `${this.id}-role-policy`,
        },
        dependencies: { role: this.role },
      },
    );
  }
}

export function isLambdaGroup(value: unknown): value is LambdaGroup {
  return (value as any)?.[lambdaGroupMark] === true;
}

/**
 * Declares a Lambda function that runs code built outside notation, such as
 * a zip file. `id` must be name-safe; see `NameSafe`. Use `$lambda` for a
 * function whose code is in the project.
 * @resource
 */
export function lambda<const Id extends string>(
  config: Omit<LambdaConfig, "id"> & { id: NameSafe<Id> },
): LambdaGroup {
  return new LambdaGroup(config);
}

function assertUniqueLambdaId(caller: string, id: string) {
  const collection = getActiveResourceCollection();
  if (!collection) return;
  if (
    collection.graph.resourceGroups.some(
      (group) => isLambdaGroup(group) && group.id === id,
    )
  ) {
    throw new Error(
      `Duplicate ${caller} id "${id}": another Lambda in this deployment already uses it. Give each Lambda a unique id.`,
    );
  }
}

const build = (functionGroup: LambdaGroup, config: LambdaConfig) => {
  const lambdaId = config.id;
  const handler = config.handler ?? "handler";
  const { code } = config;

  let zipFile: aws.lambda.LambdaDependencies["zipFile"];
  // The name of the module in the zip, without its extension.
  let fileName: string;

  if (isBundle(code)) {
    assertNodeBundle(lambdaId, code, handler);
    // The bundle is declared outside the group, so it is not added to it.
    zipFile = code;
    fileName = "index";
  } else if (code.type === "file") {
    zipFile = functionGroup.add(
      new std.fs.Zip(resourceId("lambda", lambdaId, "zip"), {
        config: { sourceFilePath: code.path },
      }),
    );
    fileName = path.parse(code.path).name;
  } else {
    zipFile = functionGroup.add(
      new std.fs.File(resourceId("lambda", lambdaId, "zip"), {
        config: { filePath: code.path },
      }),
    );
    fileName = path.parse(code.path).name;
  }

  const role = functionGroup.add(
    new aws.lambda.LambdaIamRole(resourceId("lambda", lambdaId, "role")),
  );

  functionGroup.add(
    new aws.lambda.LambdaRolePolicyAttachment(
      resourceId("lambda", lambdaId, "policy-attachment"),
      {
        dependencies: { role },
      },
    ),
  );

  const runtime = config.runtime || "nodejs22.x";

  const lambdaResource = functionGroup.add(
    new aws.lambda.LambdaFunction(resourceId("lambda", lambdaId), {
      config: {
        Handler: `${fileName}.${handler}`,
        Runtime: runtime,
        Timeout: config.timeout,
        MemorySize: config.memory,
      },
      dependencies: {
        role,
        zipFile,
      },
    }),
  );

  functionGroup.add(
    new aws.lambda.LambdaLogGroup(resourceId("lambda", lambdaId, "log-group"), {
      config: { retentionInDays: 30 },
      dependencies: { lambda: lambdaResource },
    }),
  );

  if (config.concurrency !== undefined) {
    functionGroup.add(
      new aws.lambda.LambdaFunctionConcurrency(
        resourceId("lambda", lambdaId, "concurrency"),
        {
          config: { ReservedConcurrentExecutions: config.concurrency },
          dependencies: { lambda: lambdaResource },
        },
      ),
    );
  }

  return { fn: lambdaResource, role };
};

function assertNodeBundle(id: string, code: BundleLike, handler: string) {
  const { Entry, Platform } = code.config;
  if (Platform !== "node") {
    throw new Error(
      `lambda({ id: "${id}" }) takes ${code.id} as its code, which is built for ${Platform}. Build the bundle with platform: "node".`,
    );
  }
  // A name from `export *` is not known, and a CommonJS entry has no ES
  // module exports, so neither entry is checked.
  const { names, stars } = code.exports;
  if (stars.length > 0 || names.length === 0 || names.includes(handler)) {
    return;
  }
  throw new Error(
    `lambda({ id: "${id}" }) calls the export ${handler} of ${code.id}, but its entry ${Entry} doesn't export ${handler}. Export the function from the entry, or set handler to the name that the entry exports it under.`,
  );
}
