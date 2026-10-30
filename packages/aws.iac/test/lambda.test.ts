import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-lambda";
import { createPlan } from "@notation/reconciler";
import { MemoryStateBackend } from "@notation/state";
import { fs } from "@notation/std.iac";
import { lambdaClient } from "src/utils/aws-clients";
import {
  LambdaFunction,
  type LambdaEnvironment,
  type LambdaFunctionInstance,
} from "src/resources/lambda/lambda";
import { LambdaIamRole } from "src/resources/lambda/lambda-role";
import { sortedJson } from "@notation/utils";
import { ResourceNotFoundError } from "@notation/resource";
import { CREATE_TOKEN_TAG, createTokenTagValue } from "src/utils/create-token";

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

  const lambda = new LambdaFunction("app", {
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

describe("Lambda code", () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "notation-lambda-code-"));
    filePath = path.join(directory, "handler.zip");
    await writeFile(filePath, "zip bytes");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function createLambda() {
    const zipFile = new fs.File("zip", { config: { filePath } });
    zipFile.setOutput({
      filePath,
      sourceSha256: "source",
      fileSha256: await sha256Base64(filePath),
    });
    const role = new LambdaIamRole("role", { config: { RoleName: "app" } });
    role.setOutput({ Arn: "arn:aws:iam::123456789012:role/app" } as any);
    return new LambdaFunction("app", {
      config: { FunctionName: "app", ReservedConcurrentExecutions: 1 },
      dependencies: { role, zipFile },
    });
  }

  function mockGetFunction(CodeSha256: string) {
    const response: sdk.GetFunctionResponse = {
      Configuration: {
        FunctionName: "app",
        State: "Active",
        RevisionId: "rev-1",
        PackageType: "Zip",
        Role: "arn:aws:iam::123456789012:role/app",
        CodeSha256,
      },
      Concurrency: { ReservedConcurrentExecutions: 1 },
    };
    vi.spyOn(lambdaClient, "send").mockImplementation(async (command) => {
      if (command instanceof sdk.GetFunctionCommand) return response;
      throw new Error("unexpected command");
    });
  }

  async function planUnchanged(lambda: LambdaFunctionInstance) {
    const params = await lambda.getParams();
    const plan = await createPlan({
      resources: [lambda],
      state: new MemoryStateBackend({
        app: {
          version: 1,
          id: "app",
          type: LambdaFunction.type,
          config: lambda.config,
          params,
          output: params,
          lastOperation: "create",
          lastOperationAt: "2026-07-22T00:00:00.000Z",
        },
      }),
    });
    return plan.nodes[0];
  }

  it("reports no drift when AWS reports the CodeSha256 of the archive", async () => {
    const lambda = await createLambda();
    mockGetFunction(await sha256Base64(filePath));

    expect(await planUnchanged(lambda)).toMatchObject({ decision: "noop" });
  });

  it("reports drift when AWS reports a different CodeSha256", async () => {
    const lambda = await createLambda();
    mockGetFunction("other");

    expect(await planUnchanged(lambda)).toMatchObject({
      decision: "drift-update",
    });
  });

  it("uploads the archive without passing CodeFilePath to AWS", async () => {
    const lambda = await createLambda();
    const send = vi
      .spyOn(lambdaClient, "send")
      .mockImplementation(async () => ({}));

    await lambda.create(await lambda.getParams(), undefined, "token");

    const command = send.mock.calls[0]![0] as sdk.CreateFunctionCommand;
    expect(command).toBeInstanceOf(sdk.CreateFunctionCommand);
    expect(command.input.Tags).toEqual({
      [CREATE_TOKEN_TAG]: createTokenTagValue("token"),
    });
    expect(command.input).not.toHaveProperty("CodeFilePath");
    expect(Buffer.from(command.input.Code!.ZipFile!).toString()).toBe(
      "zip bytes",
    );
  });

  it("does not create the function when the archive changed after params were computed", async () => {
    const lambda = await createLambda();
    const params = await lambda.getParams();
    await writeFile(filePath, "changed bytes");
    const changedSha256 = await sha256Base64(filePath);
    const send = vi.spyOn(lambdaClient, "send");

    await expect(lambda.create(params)).rejects.toThrow(
      `Lambda code at ${filePath} has SHA-256 ${changedSha256}, but this deploy expects ${params.CodeSha256}`,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("does not update the code when the archive changed after params were computed", async () => {
    const lambda = await createLambda();
    const params = await lambda.getParams();
    await writeFile(filePath, "changed bytes");
    const send = vi.spyOn(lambdaClient, "send");

    await expect(
      lambda.update!(
        { FunctionName: "app" },
        { CodeSha256: params.CodeSha256 } as typeof params,
        params,
        lambda.toState({
          ...params,
          FunctionArn: "arn:aws:lambda:eu-west-2:123456789012:function:app",
          RevisionId: "rev-1",
          State: "Active",
        }),
      ),
    ).rejects.toThrow("start a new deploy");
    expect(send).not.toHaveBeenCalled();
  });
});

async function sha256Base64(filePath: string) {
  const bytes = await readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("base64");
}

describe("Lambda create token", () => {
  const TOKEN = "notation:create:execution-1:app:0";
  const lambda = new LambdaFunction("app", {
    config: {} as any,
    dependencies: {} as any,
  });

  function mockTags(Tags: Record<string, string> | undefined) {
    vi.spyOn(lambdaClient, "send").mockImplementation(async (command) => {
      if (command instanceof sdk.GetFunctionCommand) return { Tags };
      throw new Error("unexpected command");
    });
  }

  it("finds the function that has the create token", async () => {
    mockTags({ [CREATE_TOKEN_TAG]: createTokenTagValue(TOKEN) });

    await expect(
      lambda.find!({ FunctionName: "app" } as any, TOKEN),
    ).resolves.toBeUndefined();
  });

  it("reports a function with the same name and no create token as not found", async () => {
    mockTags({ team: "web" });

    await expect(
      lambda.find!({ FunctionName: "app" } as any, TOKEN),
    ).rejects.toSatisfy(ResourceNotFoundError.is);
  });

  it("reports a missing function as not found", async () => {
    vi.spyOn(lambdaClient, "send").mockImplementation(async () => {
      throw new sdk.ResourceNotFoundException({
        message: "missing",
        $metadata: {},
      });
    });

    await expect(
      lambda.find!({ FunctionName: "app" } as any, TOKEN),
    ).rejects.toSatisfy(ResourceNotFoundError.is);
  });
});

describe("Lambda environment", () => {
  function createLambda(Environment?: LambdaEnvironment) {
    const lambda = new LambdaFunction("app", {
      config: {
        FunctionName: "app",
        ReservedConcurrentExecutions: 1,
        Environment,
      },
      dependencies: {} as any,
    });
    lambda.deriveParams = async () => ({});
    return lambda;
  }

  function mockGetFunction(Variables?: Record<string, string>) {
    const response: sdk.GetFunctionResponse = {
      Configuration: {
        FunctionName: "app",
        State: "Active",
        RevisionId: "rev-1",
        Environment: Variables ? { Variables } : undefined,
      },
    };
    vi.spyOn(lambdaClient, "send").mockImplementation(async (command) => {
      if (command instanceof sdk.GetFunctionCommand) return response;
      throw new Error("unexpected command");
    });
  }

  const dispatch = (id: string, match: string) => ({
    Runtime: { dispatch: { [id]: { export: "handler", match } } },
  });

  it("merges contributions to the environment key by key", async () => {
    const lambda = createLambda({ Variables: { STAGE: "prod" } });
    lambda.contribute({ Environment: dispatch("orders", "arn:orders") });
    lambda.contribute({ Environment: dispatch("refunds", "arn:refunds") });

    expect((await lambda.getParams()).Environment).toEqual({
      Variables: { STAGE: "prod" },
      Runtime: {
        dispatch: {
          orders: { export: "handler", match: "arn:orders" },
          refunds: { export: "handler", match: "arn:refunds" },
        },
      },
    });
  });

  it("names both contributors when they set one key to different values", async () => {
    const lambda = createLambda();
    lambda.contribute(
      { Environment: dispatch("orders", "arn:a") },
      { by: "a" },
    );
    lambda.contribute(
      { Environment: dispatch("orders", "arn:b") },
      { by: "b" },
    );

    await expect(lambda.getParams()).rejects.toThrow(
      /a and b both set Environment\.Runtime\.dispatch\.orders\.match/,
    );
  });

  it("encodes the runtime values as one variable of sorted JSON on create", async () => {
    const lambda = createLambda({ Variables: { STAGE: "prod" } });
    lambda.contribute({ Environment: dispatch("orders", "arn:orders") });
    const params = await lambda.getParams();
    const directory = await mkdtemp(
      path.join(tmpdir(), "notation-lambda-env-"),
    );
    const filePath = path.join(directory, "handler.zip");
    await writeFile(filePath, "zip bytes");
    const send = vi
      .spyOn(lambdaClient, "send")
      .mockImplementation(async () => ({}));

    await lambda.create({
      ...params,
      CodeFilePath: filePath,
      CodeSha256: await sha256Base64(filePath),
    });
    await rm(directory, { recursive: true, force: true });

    const command = send.mock.calls[0]![0] as sdk.CreateFunctionCommand;
    expect(command.input.Environment).toEqual({
      Variables: {
        STAGE: "prod",
        NOTATION_RUNTIME:
          '{"dispatch":{"orders":{"export":"handler","match":"arn:orders"}}}',
      },
    });
  });

  it("decodes the runtime variable on read, so an unchanged function has no drift", async () => {
    const Environment = {
      Variables: { STAGE: "prod" },
      ...dispatch("orders", "arn:orders"),
    };
    mockGetFunction({
      STAGE: "prod",
      NOTATION_RUNTIME: sortedJson.encode(Environment.Runtime),
    });

    const result = (await createLambda().read!({
      FunctionName: "app",
    })) as { Environment?: LambdaEnvironment };

    expect(result.Environment).toEqual(Environment);
  });

  it("shows a hand-edited runtime variable as drift on the key that changed", async () => {
    mockGetFunction({
      NOTATION_RUNTIME: sortedJson.encode(
        dispatch("orders", "arn:edited").Runtime,
      ),
    });

    const result = (await createLambda().read!({
      FunctionName: "app",
    })) as { Environment?: LambdaEnvironment };

    expect(result.Environment?.Runtime?.dispatch?.orders?.match).toBe(
      "arn:edited",
    );
  });

  it("keeps a runtime variable that is not JSON among the variables", async () => {
    mockGetFunction({ NOTATION_RUNTIME: "not json" });

    const result = (await createLambda().read!({
      FunctionName: "app",
    })) as { Environment?: LambdaEnvironment };

    expect(result.Environment).toEqual({
      Variables: { NOTATION_RUNTIME: "not json" },
    });
  });

  it("rejects a variable with the reserved name", async () => {
    const lambda = createLambda({ Variables: { NOTATION_RUNTIME: "x" } });
    vi.spyOn(lambdaClient, "send").mockImplementation(async () => ({}));

    await expect(
      lambda.update!(
        { FunctionName: "app" },
        { Environment: { Variables: { NOTATION_RUNTIME: "x" } } } as any,
        {} as any,
        {} as any,
      ),
    ).rejects.toThrow("NOTATION_RUNTIME is reserved");
  });

  it("clears the variables when the environment is removed", async () => {
    const send = vi
      .spyOn(lambdaClient, "send")
      .mockImplementation(async () => ({}));

    await createLambda().update!(
      { FunctionName: "app" },
      { Environment: undefined } as any,
      {} as any,
      {} as any,
    );

    const command = send.mock
      .calls[0]![0] as sdk.UpdateFunctionConfigurationCommand;
    expect(command.input.Environment).toEqual({ Variables: {} });
  });

  it("drops the runtime variable when the last contribution is removed", async () => {
    const send = vi
      .spyOn(lambdaClient, "send")
      .mockImplementation(async () => ({}));

    await createLambda().update!(
      { FunctionName: "app" },
      { Environment: { Variables: { STAGE: "prod" } } } as any,
      {} as any,
      {} as any,
    );

    const command = send.mock
      .calls[0]![0] as sdk.UpdateFunctionConfigurationCommand;
    expect(command.input.Environment).toEqual({
      Variables: { STAGE: "prod" },
    });
  });
});
