import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-lambda";
import { NodeDurableRuntime, runDurableWorkflow } from "@notation/core";
import { createResourceRegistry } from "@notation/reconciler";
import * as durable from "@notation/reconciler/durable";
import {
  collectResourceGraph,
  resource,
  type BaseResource,
} from "@notation/resource";
import { resourceClasses } from "src/registry";
import { LambdaEventBridgeRulePermission } from "src/resources/event-bridge/lambda-permission";
import { LambdaPermission } from "src/resources/lambda/lambda-permission";
import { lambdaClient } from "src/utils/aws-clients";

vi.mock("src/context", () => ({
  getAwsAccountId: async () => "123456789012",
}));

const RULE_ARN = "arn:aws:events:us-west-2:123456789012:rule/app--prod--daily";

// Stand-ins for the function and the rule, whose outputs are their params.
const Fn = resource({ type: "test/migration/Fn", provider: "test" })
  .defineSchema({
    FunctionName: {
      presence: "required",
      propertyType: "param",
      primaryKey: true,
      value: v.string(),
    },
  } as any)
  .defineOperations({
    create: async () => undefined,
    delete: async () => undefined,
  });
const Rule = resource({ type: "test/migration/Rule", provider: "test" })
  .defineSchema({
    Name: {
      presence: "required",
      propertyType: "param",
      primaryKey: true,
      value: v.string(),
    },
    Arn: { presence: "required", propertyType: "param", value: v.string() },
  } as any)
  .defineOperations({
    create: async () => undefined,
    delete: async () => undefined,
  });

let calls: string[];
let directory: string;
let runtime: NodeDurableRuntime;

// A function policy that AddPermission, RemovePermission and GetPolicy share.
beforeEach(async () => {
  calls = [];
  const statements = new Map<string, unknown>();
  vi.spyOn(lambdaClient(), "send").mockImplementation(async (command) => {
    if (command instanceof sdk.AddPermissionCommand) {
      const { StatementId, Action, Principal, SourceArn } = command.input;
      calls.push(`add ${StatementId}`);
      statements.set(StatementId!, {
        Sid: StatementId,
        Action,
        Principal: { Service: Principal },
        Condition: { ArnLike: { "AWS:SourceArn": SourceArn } },
      });
      return {};
    }
    if (command instanceof sdk.RemovePermissionCommand) {
      calls.push(`remove ${command.input.StatementId}`);
      statements.delete(command.input.StatementId!);
      return {};
    }
    if (command instanceof sdk.GetPolicyCommand) {
      return {
        Policy: JSON.stringify({ Statement: [...statements.values()] }),
      };
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  });
  directory = await mkdtemp(path.join(tmpdir(), "notation-migration-"));
  runtime = new NodeDurableRuntime({
    deployment: { app: "app", stage: "prod" },
    databasePath: path.join(directory, "workflows.db"),
  });
});

afterEach(async () => {
  runtime.close();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function deploy(executionId: string, resources: BaseResource[]) {
  return runDurableWorkflow(
    { workflowId: "deploy", runtime, executionId },
    (step, executionId) =>
      durable.deploy(step, {
        executionId,
        resources,
        state: runtime.state,
        registry: createResourceRegistry(resourceClasses),
        driftDetection: false,
      }),
  );
}

async function declare(
  permission: (fn: any, rule: any) => BaseResource,
): Promise<BaseResource[]> {
  let resources!: BaseResource[];
  await collectResourceGraph(() => {
    const fn = new Fn("fn", {
      config: { FunctionName: "app--prod--orders" } as any,
    });
    const rule = new Rule("rule", {
      config: { Name: "app--prod--daily", Arn: RULE_ARN } as any,
    });
    resources = [fn, rule, permission(fn, rule)];
  });
  return resources;
}

it("deploy creates a group's new permission before it deletes the old one as an orphan", async () => {
  await deploy(
    "deploy-1",
    await declare(
      (fn, rule) =>
        new LambdaEventBridgeRulePermission("eventbridge-permission:daily", {
          dependencies: { lambda: fn, eventBridgeRule: rule },
        }),
    ),
  );
  await deploy(
    "deploy-2",
    await declare(
      (fn, rule) =>
        new LambdaPermission("eventbridge-invoke-permission:daily", {
          config: {
            Action: "lambda:InvokeFunction",
            Principal: "events.amazonaws.com",
            SourceArn: rule.outputValue("Arn"),
          },
          dependencies: { lambda: fn },
        }),
    ),
  );

  expect(calls).toEqual([
    "add events-app--prod--daily",
    "add eventbridge-invoke-permission_daily",
    "remove events-app--prod--daily",
  ]);
  expect((await runtime.state.values()).map((node) => node.id).sort()).toEqual([
    "eventbridge-invoke-permission:daily",
    "fn",
    "rule",
  ]);
});
