import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-lambda";
import { ResourceNotFoundError } from "@notation/resource";
import { createPlan } from "@notation/reconciler";
import { MemoryStateBackend, type StateNode } from "@notation/state";
import { fs } from "@notation/std/resources";
import { lambdaClient } from "src/resources/utils/aws-clients";
import { LambdaFunctionConcurrency } from "src/resources/lambda/lambda-function-concurrency";
import { LambdaFunction } from "src/resources/lambda/lambda";
import { LambdaIamRole } from "src/resources/lambda/lambda-role";

const fn = {
  output: { FunctionName: "app--prod--orders" },
  schema: {},
} as any;
const key = { FunctionName: "app--prod--orders" };

const concurrency = (ReservedConcurrentExecutions = 10) =>
  new LambdaFunctionConcurrency("lambda:orders:concurrency", {
    config: { ReservedConcurrentExecutions },
    dependencies: { lambda: fn },
  });

function mockSend(respond: (command: unknown) => unknown = () => ({})) {
  return vi
    .spyOn(lambdaClient(), "send")
    .mockImplementation(async (command) => respond(command));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LambdaFunctionConcurrency", () => {
  it("takes the function name from the lambda", async () => {
    expect(await concurrency().getParams()).toEqual({
      FunctionName: "app--prod--orders",
      ReservedConcurrentExecutions: 10,
    });
  });

  it("rejects a reserved concurrency that is not a whole number of 0 or more", () => {
    expect(() => concurrency(1.5)).toThrow(/ReservedConcurrentExecutions/);
    expect(() => concurrency(-1)).toThrow(/ReservedConcurrentExecutions/);
  });

  it("puts the reserved concurrency on create and update", async () => {
    const send = mockSend();
    const resource = concurrency();
    const params = await resource.getParams();

    await resource.create(params);
    await resource.update!(key, params, params, {} as any);

    expect(send).toHaveBeenCalledTimes(2);
    for (const [command] of send.mock.calls) {
      expect(command).toBeInstanceOf(sdk.PutFunctionConcurrencyCommand);
      expect((command as sdk.PutFunctionConcurrencyCommand).input).toEqual({
        FunctionName: "app--prod--orders",
        ReservedConcurrentExecutions: 10,
      });
    }
  });

  it("deletes the reserved concurrency", async () => {
    const send = mockSend();

    await concurrency().delete(key, {} as any);

    const command = send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(sdk.DeleteFunctionConcurrencyCommand);
    expect((command as sdk.DeleteFunctionConcurrencyCommand).input).toEqual(
      key,
    );
  });

  it("proves its ownership by its parent, the Lambda function", () => {
    expect(concurrency().ownership).toBe("parent");
  });

  it("reads the reserved concurrency", async () => {
    mockSend(() => ({ ReservedConcurrentExecutions: 10 }));

    expect(await concurrency().read!(key, {} as any)).toEqual({
      FunctionName: "app--prod--orders",
      ReservedConcurrentExecutions: 10,
    });
  });

  it("is not found when the function reserves nothing, so drift recreates it", async () => {
    mockSend(() => ({}));
    const resource = concurrency();

    await expect(resource.read!(key, {} as any)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );

    const params = await resource.getParams();
    const plan = await createPlan({
      resources: [resource],
      state: new MemoryStateBackend({
        [resource.id]: {
          version: 1,
          id: resource.id,
          type: LambdaFunctionConcurrency.type,
          provider: "test",
          config: resource.config,
          params,
          output: params,
          lastOperation: "create",
          lastOperationAt: "2026-11-11T00:00:00.000Z",
        },
      }),
    });
    expect(plan.nodes[0]).toMatchObject({ decision: "drift-recreate" });
  });

  it("is replaced when the function is replaced, so the function keeps its reservation", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "notation-concurrency-"),
    );
    try {
      const filePath = path.join(directory, "handler.zip");
      await writeFile(filePath, "zip bytes");
      const zipFile = new fs.File("zip", { config: { filePath } });
      zipFile.setOutput({
        filePath,
        sourceSha256: "source",
        fileSha256: crypto
          .createHash("sha256")
          .update("zip bytes")
          .digest("base64"),
      });
      const role = new LambdaIamRole("role", {
        config: { RoleName: "orders" },
      });
      role.setOutput({ Arn: "arn:aws:iam::123456789012:role/orders" } as any);
      const lambda = new LambdaFunction("lambda:orders", {
        config: { FunctionName: "app--prod--orders", Tags: { team: "web" } },
        dependencies: { role, zipFile },
      });
      const resource = new LambdaFunctionConcurrency(
        "lambda:orders:concurrency",
        {
          config: { ReservedConcurrentExecutions: 10 },
          dependencies: { lambda },
        },
      );

      const lambdaParams = {
        ...(await lambda.getParams()),
        Tags: { team: "api" },
      };
      const concurrencyParams = {
        FunctionName: "app--prod--orders",
        ReservedConcurrentExecutions: 10,
      };
      const record = (
        id: string,
        type: string,
        params: StateNode["params"],
        dependsOn: string[],
      ): StateNode => ({
        version: 1,
        id,
        type,
        provider: "test",
        config: {},
        params,
        output: params,
        dependsOn,
        lastOperation: "create",
        lastOperationAt: "2026-11-11T00:00:00.000Z",
      });

      const plan = await createPlan({
        resources: [lambda, resource],
        state: new MemoryStateBackend({
          "lambda:orders": record(
            "lambda:orders",
            LambdaFunction.type,
            lambdaParams,
            [],
          ),
          "lambda:orders:concurrency": record(
            "lambda:orders:concurrency",
            LambdaFunctionConcurrency.type,
            concurrencyParams,
            ["lambda:orders"],
          ),
        }),
        driftDetection: false,
      });

      expect(plan.nodes).toMatchObject([
        {
          id: "lambda:orders",
          decision: "replace",
          replaceFields: [{ name: "Tags" }],
        },
        {
          id: "lambda:orders:concurrency",
          decision: "replace",
          replacedDependency: "lambda:orders",
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
