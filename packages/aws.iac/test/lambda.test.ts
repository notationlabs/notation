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
  type LambdaFunctionInstance,
} from "src/resources/lambda/lambda";
import { LambdaIamRole } from "src/resources/lambda/lambda-role";
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
