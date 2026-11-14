import { execFile } from "node:child_process";
import crypto from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as logs from "@aws-sdk/client-cloudwatch-logs";
import * as eventBridge from "@aws-sdk/client-eventbridge";
import * as iam from "@aws-sdk/client-iam";
import * as lambda from "@aws-sdk/client-lambda";
import * as sqs from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect } from "vitest";

export const region = process.env.AWS_REGION;

const requiredVariables = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
];
const missingVariables = requiredVariables.filter((name) => !process.env[name]);

/**
 * A `describe` whose tests fail when the AWS credentials or region are not set. Unlike
 * the Cloudflare suite, the AWS suite is not skipped without them.
 */
export function describeE2e(name: string, tests: () => void): void {
  describe(name, () => {
    beforeAll(() => {
      if (missingVariables.length > 0) {
        throw new Error(
          `The AWS end-to-end tests need AWS credentials and a region in the environment. Missing: ${missingVariables.join(", ")}.`,
        );
      }
    });
    tests();
  });
}

/**
 * Starts the name of everything that a test file creates, so that leftovers
 * can be found and two runs don't collide. Vitest evaluates this module once
 * for each test file.
 */
export const runPrefix = `ne2e-${crypto.randomBytes(3).toString("hex")}`;

export const clients = {
  iam: new iam.IAMClient({ region }),
  lambda: new lambda.LambdaClient({ region }),
  eventBridge: new eventBridge.EventBridgeClient({ region }),
  sqs: new sqs.SQSClient({ region }),
  logs: new logs.CloudWatchLogsClient({ region }),
};

// Inside this package, so that the project's imports of @notation packages
// resolve from this package's node_modules.
const tmpDir = fileURLToPath(new URL("../tmp", import.meta.url));
const packageDir = fileURLToPath(new URL("..", import.meta.url));
// The CLI depends on this package, so this package can't depend on the CLI.
const cli = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));

export type Project = {
  /** The project's directory. Set in `beforeAll`. */
  root: string;
  /** The start of the name of each resource that deploy creates. */
  scope: string;
  write(file: string, contents: string): void;
  read(file: string): string;
  /** Runs the built CLI in the project, as a user would. */
  notation(command: "deploy" | "destroy"): Promise<void>;
};

/**
 * Sets up a temp project for the tests of the enclosing `describe`, with a
 * `notation.config.ts` whose app is `runPrefix`. After the tests, destroys
 * the deployment, deletes each resource whose name starts with `runPrefix`,
 * and checks that the account has none left.
 */
export function useProject({ stage = "e2e" } = {}): Project {
  const scope = `${runPrefix}--${stage}--`;
  const project: Project = {
    root: "",
    scope,
    write(file, contents) {
      const target = path.join(project.root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents);
    },
    read: (file) => readFileSync(path.join(project.root, file), "utf8"),
    notation: async (command) => {
      try {
        await promisify(execFile)(
          process.execPath,
          [
            cli,
            command,
            "--config",
            path.join(project.root, "notation.config.ts"),
          ],
          { cwd: project.root, env: process.env, maxBuffer: 16 * 1024 * 1024 },
        );
      } catch (error) {
        const { stdout, stderr } = error as {
          stdout?: string;
          stderr?: string;
        };
        throw new Error(`notation ${command} failed:\n${stdout}\n${stderr}`, {
          cause: error,
        });
      }
    },
  };

  beforeAll(() => {
    if (missingVariables.length > 0) return;
    mkdirSync(tmpDir, { recursive: true });
    project.root = mkdtempSync(path.join(tmpDir, `${runPrefix}-`));
    // The project gets its own package.json, as this package's
    // `"sideEffects": false` would otherwise let the infra build drop the
    // project's modules. The build treats a bare import as a package only
    // when it is installed in a node_modules folder, so the project links
    // @notation/aws into its own.
    project.write("package.json", `{ "private": true }`);
    const link = path.join(project.root, "node_modules/@notation/aws");
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(packageDir, link, "dir");
    project.write(
      "notation.config.ts",
      `export default { app: "${runPrefix}", defaultStage: "${stage}", entry: "infra/main.ts" };`,
    );
    project.write("infra/main.ts", `export {};`);
  });

  afterAll(async () => {
    if (missingVariables.length > 0) return;
    try {
      if (project.root) await project.notation("destroy");
    } finally {
      try {
        // Catches what a failed deploy or destroy left behind.
        await deleteResourcesWithPrefix(runPrefix);
      } finally {
        if (project.root) {
          rmSync(project.root, { recursive: true, force: true });
        }
      }
    }
    expect(await resourcesWithPrefix(runPrefix)).toEqual(noResources);
  });

  return project;
}

export type AccountResources = {
  roles: string[];
  functions: string[];
  buses: string[];
  rules: { bus: string; name: string }[];
  queues: string[];
  logGroups: string[];
};

export const noResources: AccountResources = {
  roles: [],
  functions: [],
  buses: [],
  rules: [],
  queues: [],
  logGroups: [],
};

/**
 * The names of the account's resources that start with `prefix`. A rule is
 * listed when its own name starts with `prefix`, on the default bus or on a
 * bus that starts with `prefix`.
 */
export async function resourcesWithPrefix(
  prefix: string,
): Promise<AccountResources> {
  const buses = await busesWithPrefix(prefix);
  const rules: AccountResources["rules"] = [];
  for (const bus of ["default", ...buses]) {
    for (const name of await ruleNames(bus)) {
      if (name.startsWith(prefix)) rules.push({ bus, name });
    }
  }
  return {
    roles: await rolesWithPrefix(prefix),
    functions: await functionsWithPrefix(prefix),
    buses,
    rules,
    queues: await queuesWithPrefix(prefix),
    logGroups: await logGroupsWithPrefix(`/aws/lambda/${prefix}`),
  };
}

/**
 * Deletes each resource that `resourcesWithPrefix` lists. A rule's targets
 * are removed before the rule, the rules before their bus, and a role's
 * policies before the role, as AWS requires.
 */
export async function deleteResourcesWithPrefix(prefix: string): Promise<void> {
  const found = await resourcesWithPrefix(prefix);
  for (const { bus, name } of found.rules) {
    const ids = (await ruleTargets(bus, name)).map((target) => target.Id!);
    if (ids.length > 0) {
      await clients.eventBridge.send(
        new eventBridge.RemoveTargetsCommand({
          EventBusName: bus,
          Rule: name,
          Ids: ids,
        }),
      );
    }
    await clients.eventBridge.send(
      new eventBridge.DeleteRuleCommand({ EventBusName: bus, Name: name }),
    );
  }
  for (const name of found.buses) {
    await clients.eventBridge.send(
      new eventBridge.DeleteEventBusCommand({ Name: name }),
    );
  }
  for (const name of found.functions) {
    await clients.lambda.send(
      new lambda.DeleteFunctionCommand({ FunctionName: name }),
    );
  }
  for (const name of found.roles) {
    for (const policy of await inlinePolicyNames(name)) {
      await clients.iam.send(
        new iam.DeleteRolePolicyCommand({ RoleName: name, PolicyName: policy }),
      );
    }
    for (const arn of await attachedPolicyArns(name)) {
      await clients.iam.send(
        new iam.DetachRolePolicyCommand({ RoleName: name, PolicyArn: arn }),
      );
    }
    await clients.iam.send(new iam.DeleteRoleCommand({ RoleName: name }));
  }
  for (const url of found.queues) {
    await clients.sqs.send(new sqs.DeleteQueueCommand({ QueueUrl: url }));
  }
  for (const name of found.logGroups) {
    await clients.logs.send(
      new logs.DeleteLogGroupCommand({ logGroupName: name }),
    );
  }
}

export async function rolesWithPrefix(prefix: string): Promise<string[]> {
  const names: string[] = [];
  let Marker: string | undefined;
  do {
    const page = await clients.iam.send(new iam.ListRolesCommand({ Marker }));
    for (const role of page.Roles ?? []) {
      if (role.RoleName!.startsWith(prefix)) names.push(role.RoleName!);
    }
    Marker = page.IsTruncated ? page.Marker : undefined;
  } while (Marker);
  return names.sort();
}

export async function functionsWithPrefix(prefix: string): Promise<string[]> {
  const names: string[] = [];
  let Marker: string | undefined;
  do {
    const page = await clients.lambda.send(
      new lambda.ListFunctionsCommand({ Marker }),
    );
    for (const fn of page.Functions ?? []) {
      if (fn.FunctionName!.startsWith(prefix)) names.push(fn.FunctionName!);
    }
    Marker = page.NextMarker;
  } while (Marker);
  return names.sort();
}

export async function busesWithPrefix(prefix: string): Promise<string[]> {
  const names: string[] = [];
  let NextToken: string | undefined;
  do {
    const page = await clients.eventBridge.send(
      new eventBridge.ListEventBusesCommand({ NamePrefix: prefix, NextToken }),
    );
    for (const bus of page.EventBuses ?? []) names.push(bus.Name!);
    NextToken = page.NextToken;
  } while (NextToken);
  return names.sort();
}

export async function ruleNames(bus: string): Promise<string[]> {
  const names: string[] = [];
  let NextToken: string | undefined;
  do {
    const page = await clients.eventBridge.send(
      new eventBridge.ListRulesCommand({ EventBusName: bus, NextToken }),
    );
    for (const rule of page.Rules ?? []) names.push(rule.Name!);
    NextToken = page.NextToken;
  } while (NextToken);
  return names.sort();
}

export async function ruleTargets(
  bus: string,
  rule: string,
): Promise<eventBridge.Target[]> {
  const { Targets } = await clients.eventBridge.send(
    new eventBridge.ListTargetsByRuleCommand({ EventBusName: bus, Rule: rule }),
  );
  return Targets ?? [];
}

export async function queuesWithPrefix(prefix: string): Promise<string[]> {
  const urls: string[] = [];
  let NextToken: string | undefined;
  do {
    const page = await clients.sqs.send(
      new sqs.ListQueuesCommand({ QueueNamePrefix: prefix, NextToken }),
    );
    urls.push(...(page.QueueUrls ?? []));
    NextToken = page.NextToken;
  } while (NextToken);
  return urls.sort();
}

export async function logGroupsWithPrefix(prefix: string): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await clients.logs.send(
      new logs.DescribeLogGroupsCommand({
        logGroupNamePrefix: prefix,
        nextToken,
      }),
    );
    for (const group of page.logGroups ?? []) names.push(group.logGroupName!);
    nextToken = page.nextToken;
  } while (nextToken);
  return names.sort();
}

export async function inlinePolicyNames(role: string): Promise<string[]> {
  const { PolicyNames } = await clients.iam.send(
    new iam.ListRolePoliciesCommand({ RoleName: role }),
  );
  return PolicyNames ?? [];
}

export async function attachedPolicyArns(role: string): Promise<string[]> {
  const { AttachedPolicies } = await clients.iam.send(
    new iam.ListAttachedRolePoliciesCommand({ RoleName: role }),
  );
  return (AttachedPolicies ?? []).map((policy) => policy.PolicyArn!);
}

/** Whether the role exists. */
export async function roleExists(role: string): Promise<boolean> {
  try {
    await clients.iam.send(new iam.GetRoleCommand({ RoleName: role }));
    return true;
  } catch (error) {
    if (error instanceof iam.NoSuchEntityException) return false;
    throw error;
  }
}

/** The name of a role, from its ARN. */
export function roleNameOf(arn: string): string {
  return arn.split("/").at(-1)!;
}
