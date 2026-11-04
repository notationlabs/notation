import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-lambda";
import { createPlan, decideDriftAction } from "@notation/reconciler";
import { MemoryStateBackend } from "@notation/state";
import { fs } from "@notation/std.iac";
import { lambdaClient } from "src/utils/aws-clients";
import {
  environmentSizeIssue,
  LambdaFunction,
  type LambdaFunctionInstance,
} from "src/resources/lambda/lambda";
import { LambdaIamRole } from "src/resources/lambda/lambda-role";
import {
  OutputValue,
  ResourceNotFoundError,
  UNKNOWN_AFTER_APPLY,
} from "@notation/resource";
import { CREATE_TOKEN_TAG, createTokenTagValue } from "src/utils/create-token";
import { decodeRuntime, encodeRuntime, runtimeVariable } from "src/shared";

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

describe("Lambda config values", () => {
  function declare(config: Record<string, unknown>) {
    return () =>
      new LambdaFunction("app", {
        config: {
          FunctionName: "app",
          ReservedConcurrentExecutions: 1,
          ...config,
        } as any,
        dependencies: {} as any,
      });
  }

  it("rejects a memory size that is not a number when the function is declared", () => {
    expect(declare({ MemorySize: Number(undefined) })).toThrow(
      expect.objectContaining({
        _tag: "ValueValidationError",
        field: "MemorySize",
        point: "declaration",
      }),
    );
  });

  it("rejects a runtime that Lambda does not have", () => {
    expect(declare({ Runtime: "nodejs99.x" })).toThrow(/Runtime/);
  });

  it("rejects a code signing policy other than Warn or Enforce", () => {
    expect(declare({ CodeSigningPolicy: "Audit" })).toThrow(
      /CodeSigningPolicy/,
    );
  });

  it("accepts valid config", () => {
    expect(
      declare({
        MemorySize: 512,
        Runtime: "nodejs22.x",
        Architectures: ["arm64"],
        Environment: { Variables: { STAGE: "prod" } },
      }),
    ).not.toThrow();
  });
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

  it("encodes the runtime map into one variable on create", async () => {
    const lambda = await createLambda();
    const runtime = {
      dispatch: {
        "orders-app-mapping": {
          export: "processOrders",
          match: { queueArn: "arn:orders" },
        },
      },
    };
    lambda.contribute({ Environment: { Runtime: runtime } });
    const send = vi
      .spyOn(lambdaClient, "send")
      .mockImplementation(async () => ({}));

    await lambda.create(await lambda.getParams());

    const command = send.mock.calls[0]![0] as sdk.CreateFunctionCommand;
    expect(command.input.Environment).toEqual({
      Variables: { [runtimeVariable]: encodeRuntime(runtime) },
    });
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
  function createLambda(Environment?: sdk.Environment) {
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

  it("merges contributions to the environment key by key", async () => {
    const lambda = createLambda({ Variables: { STAGE: "prod" } });
    lambda.contribute({ Environment: { Variables: { ORDERS: "arn:orders" } } });
    lambda.contribute({
      Environment: { Variables: { REFUNDS: "arn:refunds" } },
    });

    expect((await lambda.getParams()).Environment).toEqual({
      Variables: {
        STAGE: "prod",
        ORDERS: "arn:orders",
        REFUNDS: "arn:refunds",
      },
    });
  });

  it("names both contributors when they set one key to different values", async () => {
    const lambda = createLambda();
    lambda.contribute({ Environment: { Variables: { ORDERS: "arn:a" } } });
    lambda.contribute({ Environment: { Variables: { ORDERS: "arn:b" } } });

    await expect(lambda.getParams()).rejects.toThrow(
      /lambda\.test\.ts:\d+ and .*lambda\.test\.ts:\d+ both set Environment\.Variables\.ORDERS/,
    );
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

  const runtime = {
    dispatch: {
      "todo-api-GET-/todos": {
        export: "getTodos",
        match: { apiId: "api-1", routeKey: "GET /todos" },
      },
    },
  };

  it("merges dispatch entries from several contributors", async () => {
    const lambda = createLambda();
    lambda.contribute({
      Environment: { Runtime: { dispatch: runtime.dispatch } },
    });
    lambda.contribute({
      Environment: {
        Runtime: {
          dispatch: {
            "orders-app-mapping": {
              export: "processOrders",
              match: { queueArn: "arn:orders" },
            },
          },
        },
      },
    });

    expect((await lambda.getParams()).Environment?.Runtime?.dispatch).toEqual({
      ...runtime.dispatch,
      "orders-app-mapping": {
        export: "processOrders",
        match: { queueArn: "arn:orders" },
      },
    });
  });

  it("encodes the runtime map into one variable on update", async () => {
    const send = vi
      .spyOn(lambdaClient, "send")
      .mockImplementation(async () => ({}));

    await createLambda().update!(
      { FunctionName: "app" },
      {
        Environment: { Variables: { STAGE: "prod" }, Runtime: runtime },
      } as any,
      {} as any,
      {} as any,
    );

    const command = send.mock
      .calls[0]![0] as sdk.UpdateFunctionConfigurationCommand;
    expect(command.input.Environment).toEqual({
      Variables: {
        STAGE: "prod",
        [runtimeVariable]: encodeRuntime(runtime),
      },
    });
  });

  it("rejects a variable that uses the reserved name", async () => {
    vi.spyOn(lambdaClient, "send").mockImplementation(async () => ({}));

    await expect(
      createLambda().update!(
        { FunctionName: "app" },
        {
          Environment: {
            Variables: { [runtimeVariable]: "{}" },
            Runtime: runtime,
          },
        } as any,
        {} as any,
        {} as any,
      ),
    ).rejects.toThrow(`${runtimeVariable} is reserved`);
  });

  it("decodes the runtime map on read", async () => {
    vi.spyOn(lambdaClient, "send").mockImplementation(async () => ({
      Configuration: {
        FunctionName: "app",
        State: "Active",
        RevisionId: "rev-1",
        Environment: {
          Variables: {
            STAGE: "prod",
            [runtimeVariable]: encodeRuntime(runtime),
          },
        },
      },
    }));

    const result: any = await createLambda().read!(
      { FunctionName: "app" },
      {} as any,
    );

    expect(result.Environment).toEqual({
      Variables: { STAGE: "prod" },
      Runtime: runtime,
    });
  });

  it("reads an environment that holds only the runtime map without variables", async () => {
    vi.spyOn(lambdaClient, "send").mockImplementation(async () => ({
      Configuration: {
        FunctionName: "app",
        State: "Active",
        RevisionId: "rev-1",
        Environment: {
          Variables: { [runtimeVariable]: encodeRuntime(runtime) },
        },
      },
    }));

    const result: any = await createLambda().read!(
      { FunctionName: "app" },
      {} as any,
    );

    expect(result.Environment).toEqual({ Runtime: runtime });
  });

  function mockRead(Variables: Record<string, string>) {
    vi.spyOn(lambdaClient, "send").mockImplementation(async () => ({
      Configuration: {
        FunctionName: "app",
        State: "Active",
        RevisionId: "rev-1",
        Environment: { Variables },
      },
    }));
  }

  async function driftDecision(lambda: LambdaFunctionInstance) {
    const params = await lambda.getParams();
    const output = await lambda.read!({ FunctionName: "app" }, {} as any);
    return decideDriftAction({
      resource: lambda,
      params,
      driftRead: { kind: "present", output: output as any },
    }).decision;
  }

  it("reports no drift when the function holds only the runtime map", async () => {
    const lambda = createLambda();
    lambda.contribute({ Environment: { Runtime: runtime } });
    mockRead({ [runtimeVariable]: encodeRuntime(runtime) });

    expect(await driftDecision(lambda)).toBe("noop");
  });

  it("reports drift when the runtime variable is not a valid runtime map", async () => {
    const lambda = createLambda();
    lambda.contribute({ Environment: { Runtime: runtime } });
    mockRead({ [runtimeVariable]: "{not json" });

    const result: any = await lambda.read!({ FunctionName: "app" }, {} as any);

    expect(result.Environment).toEqual({
      Variables: { [runtimeVariable]: "{not json" },
    });
    expect(await driftDecision(lambda)).toBe("drift-update");
  });

  it("rejects an environment over Lambda's 4 KB limit", async () => {
    const send = vi.spyOn(lambdaClient, "send");
    const dispatch: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      dispatch[`todo-api-GET-/todos/${i}`] = {
        export: `getTodo${i}`,
        match: { apiId: "api-1", routeKey: `GET /todos/${i}` },
      };
    }

    await expect(
      createLambda().update!(
        { FunctionName: "app" },
        { Environment: { Runtime: { dispatch } } } as any,
        { FunctionName: "app" } as any,
        {} as any,
      ),
    ).rejects.toThrow(
      /Lambda function app: the environment is \d+ bytes, over Lambda's limit of 4096 bytes. The largest values are the dispatch entry todo-api-GET-\/todos\/\d+ \(\d+ bytes\)/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  function createPlannableLambda() {
    const zipFile = new fs.File("zip", { config: { filePath: "app.zip" } });
    zipFile.setOutput({
      filePath: "app.zip",
      sourceSha256: "source",
      fileSha256: "sha",
    });
    const role = new LambdaIamRole("role", { config: { RoleName: "app" } });
    role.setOutput({ Arn: "arn:aws:iam::123456789012:role/app" } as any);
    return new LambdaFunction("app", {
      config: { FunctionName: "app", ReservedConcurrentExecutions: 1 },
      dependencies: { role, zipFile },
    });
  }

  it("fails at plan when the environment is over Lambda's limit, naming the largest reads", async () => {
    const lambda = createPlannableLambda();
    lambda.contribute({
      Environment: {
        Variables: { STAGE: "prod" },
        Runtime: {
          outputs: {
            "infra/orders#settings": { tags: "x".repeat(4000) },
            "infra/orders#orderQueue.url": UNKNOWN_AFTER_APPLY,
          },
        },
      },
    });

    await expect(
      createPlan({ resources: [lambda], state: new MemoryStateBackend({}) }),
    ).rejects.toThrow(
      /Invalid Environment for app \(aws\/lambda\/LambdaFunction\) at plan.*Runtime\.outputs\.infra\/orders#settings: the environment is at least \d+ bytes, over Lambda's limit of 4096 bytes. The largest values are the read infra\/orders#settings \(40\d\d bytes\), the read infra\/orders#orderQueue.url \(\d+ bytes\), the variable STAGE \(14 bytes\)/,
    );
  });

  it("counts an output value as an empty string in the size check", () => {
    const role = new LambdaIamRole("role", { config: { RoleName: "app" } });
    const issue = environmentSizeIssue({
      Runtime: {
        outputs: {
          "infra/orders#settings": "x".repeat(4100),
          "infra/orders#orderQueue.url": new OutputValue(role, ["Arn"]),
        },
      },
    } as any);

    expect(issue).toEqual({
      path: ["Runtime", "outputs", "infra/orders#settings"],
      message: expect.stringMatching(
        /^the environment is at least \d+ bytes, over Lambda's limit of 4096 bytes/,
      ),
    });
  });

  it("accepts an environment under Lambda's limit that holds an output value at declaration", () => {
    const role = new LambdaIamRole("role", { config: { RoleName: "app" } });
    expect(
      () =>
        new LambdaFunction("app", {
          config: {
            FunctionName: "app",
            Environment: {
              Runtime: {
                outputs: {
                  "infra/orders#settings": "x".repeat(3900),
                  "infra/orders#orderQueue.url": new OutputValue(role, [
                    "Arn",
                  ]),
                },
              },
            },
          } as any,
          dependencies: { role } as any,
        }),
    ).not.toThrow();
  });

  it("counts other variables towards the limit at plan", async () => {
    const lambda = createPlannableLambda();
    lambda.contribute({
      Environment: {
        Variables: { BIG: "x".repeat(3000) },
        Runtime: { outputs: { "infra/orders#settings": "y".repeat(1100) } },
      },
    });

    await expect(
      createPlan({ resources: [lambda], state: new MemoryStateBackend({}) }),
    ).rejects.toThrow(/over Lambda's limit of 4096 bytes/);
  });

  it("clears the variables when an update sets an empty environment", async () => {
    const send = vi
      .spyOn(lambdaClient, "send")
      .mockImplementation(async () => ({}));

    await createLambda().update!(
      { FunctionName: "app" },
      { Environment: {} } as any,
      { FunctionName: "app" } as any,
      {} as any,
    );

    const command = send.mock
      .calls[0]![0] as sdk.UpdateFunctionConfigurationCommand;
    expect(command.input.Environment).toEqual({ Variables: {} });
  });
});

describe("runtime map encoding", () => {
  it("encodes routes and queue subscriptions as sorted JSON, and decodes them back", () => {
    const runtime = {
      dispatch: {
        "todo-api-GET-/todos/{id}": {
          export: "getTodo",
          match: { apiId: "api-1", routeKey: "GET /todos/{id}" },
        },
        "orders-app-mapping": {
          export: "processOrders",
          match: { queueArn: "arn:orders" },
        },
      },
    };

    expect(encodeRuntime(runtime)).toBe(
      '{"dispatch":{"orders-app-mapping":{"export":"processOrders","match":{"queueArn":"arn:orders"}},"todo-api-GET-/todos/{id}":{"export":"getTodo","match":{"apiId":"api-1","routeKey":"GET /todos/{id}"}}}}',
    );
    expect(decodeRuntime(encodeRuntime(runtime))).toEqual(runtime);
  });

  it("rejects text that is not a runtime map", () => {
    expect(() => decodeRuntime('{"dispatch":{"a":{"export":1}}}')).toThrow(
      `${runtimeVariable} does not hold a valid runtime map`,
    );
    expect(() => decodeRuntime("[]")).toThrow();
  });
});
