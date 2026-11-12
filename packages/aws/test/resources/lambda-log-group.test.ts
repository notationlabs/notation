import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-cloudwatch-logs";
import { NodeDurableRuntime, runDurableWorkflow } from "@notation/core";
import * as durable from "@notation/reconciler/durable";
import {
  resource,
  ResourceAlreadyExistsError,
  ResourceCreationUnknownError,
  ResourceNotFoundError,
} from "@notation/resource";
import { cloudWatchLogsClient } from "src/resources/utils/aws-clients";
import { LambdaLogGroup } from "src/resources/lambda/lambda-log-group";

const params = { logGroupName: "/aws/lambda/app", retentionInDays: 7 };

const logGroup = new LambdaLogGroup("log-group", {
  config: { retentionInDays: 7 },
  dependencies: { lambda: { output: { FunctionName: "app" } } as any },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LambdaLogGroup update", () => {
  const key = { logGroupName: "/aws/lambda/app" };
  const arn = "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/lambda/app";

  function recordSent(currentTags: Record<string, string> = {}) {
    const sent: unknown[] = [];
    vi.spyOn(cloudWatchLogsClient(), "send").mockImplementation(
      async (command: unknown) => {
        if (command instanceof sdk.DescribeLogGroupsCommand) {
          return {
            logGroups: [{ logGroupName: key.logGroupName, arn: `${arn}:*` }],
          };
        }
        if (command instanceof sdk.ListTagsForResourceCommand) {
          return { tags: currentTags };
        }
        sent.push(command);
        return {};
      },
    );
    return sent as { input: unknown }[];
  }

  it("sets only the retention when only the retention changed", async () => {
    const sent = recordSent();

    await logGroup.update!(
      key,
      { retentionInDays: 14 } as any,
      {
        ...params,
        retentionInDays: 14,
        kmsKeyId: "arn:aws:kms:eu-west-1:123456789012:key/a",
        tags: { team: "a" },
      },
      {} as any,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(sdk.PutRetentionPolicyCommand);
    expect(sent[0]!.input).toEqual({
      logGroupName: "/aws/lambda/app",
      retentionInDays: 14,
    });
  });

  it("associates a KMS key, and disassociates one that config removed", async () => {
    const sent = recordSent();
    const kmsKeyId = "arn:aws:kms:eu-west-1:123456789012:key/a";

    await logGroup.update!(
      key,
      { kmsKeyId } as any,
      { ...params, kmsKeyId },
      {} as any,
    );
    await logGroup.update!(
      key,
      { kmsKeyId: undefined } as any,
      params,
      {} as any,
    );

    expect(sent[0]).toBeInstanceOf(sdk.AssociateKmsKeyCommand);
    expect(sent[0]!.input).toEqual({
      logGroupName: "/aws/lambda/app",
      kmsKeyId,
    });
    expect(sent[1]).toBeInstanceOf(sdk.DisassociateKmsKeyCommand);
    expect(sent).toHaveLength(2);
  });

  it("makes the tags equal to the configured tags", async () => {
    const sent = recordSent({ team: "a", old: "x" });
    const tags = { team: "b" };

    await logGroup.update!(
      key,
      { tags } as any,
      { ...params, tags },
      {} as any,
    );

    expect(sent[0]).toBeInstanceOf(sdk.UntagResourceCommand);
    expect(sent[0]!.input).toEqual({ resourceArn: arn, tagKeys: ["old"] });
    expect(sent[1]).toBeInstanceOf(sdk.TagResourceCommand);
    expect(sent[1]!.input).toEqual({ resourceArn: arn, tags });
    expect(sent).toHaveLength(2);
  });
});

describe("LambdaLogGroup create", () => {
  it("reports a failure after the log group was created as unknown", async () => {
    vi.spyOn(cloudWatchLogsClient(), "send").mockImplementation(
      async (command: unknown) => {
        if (command instanceof sdk.PutRetentionPolicyCommand) {
          throw new Error("access denied");
        }
        return {};
      },
    );

    await expect(logGroup.create(params)).rejects.toSatisfy(
      ResourceCreationUnknownError.is,
    );
  });

  it("reports a log group that already exists as ResourceAlreadyExistsError", async () => {
    vi.spyOn(cloudWatchLogsClient(), "send").mockImplementation(async () => {
      throw new sdk.ResourceAlreadyExistsException({
        message: "The specified log group already exists",
        $metadata: {},
      });
    });

    await expect(logGroup.create(params)).rejects.toSatisfy(
      ResourceAlreadyExistsError.is,
    );
  });
});

describe("LambdaLogGroup read", () => {
  const key = { logGroupName: "/aws/lambda/app" };

  it("reads the log group with the exact name, not one that shares its prefix", async () => {
    vi.spyOn(cloudWatchLogsClient(), "send").mockImplementation(async () => ({
      logGroups: [
        { logGroupName: "/aws/lambda/app-2", retentionInDays: 30 },
        { logGroupName: "/aws/lambda/app", retentionInDays: 7 },
      ],
    }));

    await expect(logGroup.read!(key)).resolves.toEqual({
      logGroupName: "/aws/lambda/app",
      retentionInDays: 7,
    });
  });

  it("reads the retention of a log group that Lambda made, which has none, as 0", async () => {
    vi.spyOn(cloudWatchLogsClient(), "send").mockImplementation(async () => ({
      logGroups: [{ logGroupName: "/aws/lambda/app" }],
    }));

    await expect(logGroup.read!(key)).resolves.toEqual({
      logGroupName: "/aws/lambda/app",
      retentionInDays: 0,
    });
  });

  it("reports a missing log group as not found", async () => {
    vi.spyOn(cloudWatchLogsClient(), "send").mockImplementation(async () => ({
      logGroups: [{ logGroupName: "/aws/lambda/app-2" }],
    }));

    await expect(logGroup.read!(key)).rejects.toSatisfy(
      ResourceNotFoundError.is,
    );
  });
});

describe("LambdaLogGroup in the durable reconciler", () => {
  const Function = resource({ type: "test/aws/function", provider: "test" })
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

  /**
   * Deploys a function and its log group. `send` answers the CloudWatch
   * Logs commands.
   */
  async function deployLogGroup(send: (command: unknown) => unknown) {
    const sent: unknown[] = [];
    vi.spyOn(cloudWatchLogsClient(), "send").mockImplementation(
      async (command: unknown) => {
        sent.push(command);
        return send(command);
      },
    );

    const fn = new Function("function", {
      config: { FunctionName: "app" } as any,
    });
    const resources = [
      fn,
      new LambdaLogGroup("log-group", {
        config: { retentionInDays: 7 },
        dependencies: { lambda: fn as any },
      }),
    ];
    const directory = await mkdtemp(path.join(tmpdir(), "notation-logs-"));
    const runtime = new NodeDurableRuntime({
      deployment: { app: "aws", stage: "test" },
      databasePath: path.join(directory, "workflows.db"),
    });
    const error = await runDurableWorkflow(
      { workflowId: "deploy", runtime, executionId: "deploy-1" },
      (step, executionId) =>
        durable.deploy(step, {
          executionId,
          resources,
          state: runtime.state,
          driftDetection: false,
        }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    const record = await runtime.state.get("log-group");
    runtime.close();
    await rm(directory, { recursive: true, force: true });
    const retention = sent.filter(
      (command) => command instanceof sdk.PutRetentionPolicyCommand,
    ) as sdk.PutRetentionPolicyCommand[];
    return { error, record, retention };
  }

  it("takes over a log group that exists already, and sets its retention in the same deploy", async () => {
    // As Lambda makes a function's log group when the function first logs.
    const { error, record, retention } = await deployLogGroup((command) => {
      if (command instanceof sdk.CreateLogGroupCommand) {
        throw new sdk.ResourceAlreadyExistsException({
          message: "The specified log group already exists",
          $metadata: {},
        });
      }
      if (command instanceof sdk.DescribeLogGroupsCommand) {
        return { logGroups: [{ logGroupName: "/aws/lambda/app" }] };
      }
      return {};
    });

    expect(error).toBeUndefined();
    expect(retention.map((command) => command.input)).toEqual([
      { logGroupName: "/aws/lambda/app", retentionInDays: 7 },
    ]);
    expect(record).toMatchObject({
      lastOperation: "update",
      params: { logGroupName: "/aws/lambda/app", retentionInDays: 7 },
    });
  });

  it("takes over the log group that its create made when the retention could not be set, and sets it in the same deploy", async () => {
    let failures = 1;
    const { error, record, retention } = await deployLogGroup((command) => {
      if (command instanceof sdk.PutRetentionPolicyCommand && failures-- > 0) {
        throw new Error("throttled");
      }
      if (command instanceof sdk.DescribeLogGroupsCommand) {
        return { logGroups: [{ logGroupName: "/aws/lambda/app" }] };
      }
      return {};
    });

    expect(error).toBeUndefined();
    expect(retention).toHaveLength(2);
    expect(record).toMatchObject({
      lastOperation: "update",
      params: { logGroupName: "/aws/lambda/app", retentionInDays: 7 },
    });
  });
});
