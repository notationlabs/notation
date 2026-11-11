import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-lambda";
import { ResourceNotFoundError } from "@notation/resource";
import { createPlan } from "@notation/reconciler";
import { MemoryStateBackend } from "@notation/state";
import { lambdaClient } from "src/resources/utils/aws-clients";
import { LambdaFunctionConcurrency } from "src/resources/lambda/lambda-function-concurrency";

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
});
