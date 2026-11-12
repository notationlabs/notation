import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-lambda";
import {
  ResourceAlreadyExistsError,
  ResourceNotFoundError,
  ResourceOperationPendingError,
  ValueValidationError,
} from "@notation/resource";
import { lambdaClient } from "src/resources/utils/aws-clients";
import { LambdaEventSourceMapping } from "src/resources/lambda/lambda-event-source-mapping";

const queueArn = "arn:aws:sqs:eu-west-2:123456789012:orders";

function createMapping() {
  return new LambdaEventSourceMapping("orders-app-mapping", {
    config: { EventSourceArn: queueArn, FunctionName: "app" },
  });
}

function mockSend(respond: (command: unknown) => unknown) {
  return vi
    .spyOn(lambdaClient(), "send")
    .mockImplementation(async (command) => respond(command));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LambdaEventSourceMapping", () => {
  it("retries a create that fails while the role's permissions propagate", async () => {
    mockSend(() => {
      throw new sdk.InvalidParameterValueException({
        message:
          "The function execution role does not have permissions to call ReceiveMessage on SQS",
        $metadata: {},
      });
    });

    await expect(
      createMapping().create({ EventSourceArn: queueArn, FunctionName: "app" }),
    ).rejects.toBeInstanceOf(ResourceOperationPendingError);
  });

  it("reports a second mapping of a queue to the function as already existing", async () => {
    mockSend(() => {
      throw new sdk.ResourceConflictException({
        message:
          'An event source mapping with SQS arn (" ' +
          queueArn +
          ' ") and function (" app ") already exists. Please update or ' +
          "delete the existing mapping with UUID uuid-1",
        $metadata: {},
      });
    });

    await expect(
      createMapping().create({ EventSourceArn: queueArn, FunctionName: "app" }),
    ).rejects.toSatisfy(ResourceAlreadyExistsError.is);
  });

  it("creates the mapping with no tags", async () => {
    const send = mockSend(() => ({ UUID: "uuid-1" }));

    await createMapping().create({
      EventSourceArn: queueArn,
      FunctionName: "app",
    });

    expect(
      (send.mock.calls[0]![0] as sdk.CreateEventSourceMappingCommand).input,
    ).toEqual({ EventSourceArn: queueArn, FunctionName: "app" });
  });

  it("finds the mapping from the event source to the function", async () => {
    const send = mockSend((command) => {
      const { Marker } = (command as sdk.ListEventSourceMappingsCommand).input;
      return Marker
        ? { EventSourceMappings: [{ UUID: "uuid-1" }] }
        : { EventSourceMappings: [], NextMarker: "page-2" };
    });

    await expect(
      createMapping().find!({ EventSourceArn: queueArn, FunctionName: "app" }),
    ).resolves.toEqual({ UUID: "uuid-1" });
    expect(
      (send.mock.calls[0]![0] as sdk.ListEventSourceMappingsCommand).input,
    ).toEqual({
      EventSourceArn: queueArn,
      FunctionName: "app",
      Marker: undefined,
    });
  });

  it("reports no mapping when the function has none from the event source", async () => {
    mockSend(() => ({ EventSourceMappings: [] }));

    await expect(
      createMapping().find!({ EventSourceArn: queueArn, FunctionName: "app" }),
    ).rejects.toSatisfy(ResourceNotFoundError.is);
  });

  it("fails to find the mapping when the function has several from the event source, and names them", async () => {
    mockSend(() => ({
      EventSourceMappings: [{ UUID: "uuid-1" }, { UUID: "uuid-2" }],
    }));

    const found = createMapping().find!({
      EventSourceArn: queueArn,
      FunctionName: "app",
    });

    await expect(found).rejects.toThrow("uuid-1, uuid-2");
    await expect(found).rejects.not.toSatisfy(ResourceNotFoundError.is);
  });

  it("waits while the mapping is being created", async () => {
    mockSend(() => ({ UUID: "uuid", State: "Creating" }));

    await expect(
      createMapping().read!({ UUID: "uuid" }),
    ).rejects.toBeInstanceOf(ResourceOperationPendingError);
  });

  it("reads whether the mapping is enabled from its state", async () => {
    mockSend(() => ({
      UUID: "uuid",
      EventSourceArn: queueArn,
      FunctionArn: "arn:aws:lambda:eu-west-2:123456789012:function:app",
      BatchSize: 10,
      MaximumBatchingWindowInSeconds: 0,
      State: "Disabled",
    }));

    const result = await createMapping().read!({ UUID: "uuid" });

    expect(result).toMatchObject({ BatchSize: 10, Enabled: false });
  });

  it("resets a removed field to the API's default", async () => {
    const send = mockSend(() => ({}));

    await createMapping().update!(
      { UUID: "uuid" },
      {
        BatchSize: undefined,
        MaximumBatchingWindowInSeconds: undefined,
      } as any,
      { EventSourceArn: queueArn, FunctionName: "app" },
      {} as any,
    );

    const command = send.mock
      .calls[0]![0] as sdk.UpdateEventSourceMappingCommand;
    expect(command.input).toEqual({
      UUID: "uuid",
      BatchSize: 10,
      MaximumBatchingWindowInSeconds: 0,
    });
  });

  it("removes a removed response type and scaling config", async () => {
    const send = mockSend(() => ({}));

    await createMapping().update!(
      { UUID: "uuid" },
      { FunctionResponseTypes: undefined, ScalingConfig: undefined } as any,
      { EventSourceArn: queueArn, FunctionName: "app" },
      {} as any,
    );

    const command = send.mock
      .calls[0]![0] as sdk.UpdateEventSourceMappingCommand;
    expect(command.input).toEqual({
      UUID: "uuid",
      FunctionResponseTypes: [],
      ScalingConfig: {},
    });
  });

  it("reads a mapping with no response types or scaling config as empty", async () => {
    mockSend(() => ({
      UUID: "uuid",
      EventSourceArn: queueArn,
      FunctionArn: "arn:aws:lambda:eu-west-2:123456789012:function:app",
      BatchSize: 10,
      MaximumBatchingWindowInSeconds: 0,
      State: "Enabled",
    }));

    const result = await createMapping().read!({ UUID: "uuid" });

    expect(result).toMatchObject({
      FunctionResponseTypes: [],
      ScalingConfig: {},
    });
  });

  it("rejects a maximum concurrency that Lambda does not allow", () => {
    expect(
      () =>
        new LambdaEventSourceMapping("bad-mapping", {
          config: {
            EventSourceArn: queueArn,
            FunctionName: "app",
            ScalingConfig: { MaximumConcurrency: 1 },
          },
        }),
    ).toThrow(ValueValidationError);
  });

  it.each([
    { BatchSize: 0 },
    { BatchSize: 10_001 },
    { MaximumBatchingWindowInSeconds: 301 },
  ])("rejects %o, which Lambda does not allow", (config) => {
    expect(
      () =>
        new LambdaEventSourceMapping("bad-mapping", {
          config: { EventSourceArn: queueArn, FunctionName: "app", ...config },
        }),
    ).toThrow(ValueValidationError);
  });

  it("sends only the fields that changed", async () => {
    const send = mockSend(() => ({}));

    await createMapping().update!(
      { UUID: "uuid" },
      { BatchSize: 5 } as any,
      { EventSourceArn: queueArn, FunctionName: "app", BatchSize: 5 },
      {} as any,
    );

    const command = send.mock
      .calls[0]![0] as sdk.UpdateEventSourceMappingCommand;
    expect(command.input).toEqual({ UUID: "uuid", BatchSize: 5 });
  });
});
