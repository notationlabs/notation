import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-eventbridge";
import {
  ResourceAlreadyExistsError,
  ResourceCreationUnknownError,
  ResourceNotFoundError,
} from "@notation/resource";
import { eventBridgeClient } from "src/resources/utils/aws-clients";
import {
  DefaultEventBus,
  EventBus,
} from "src/resources/event-bridge/event-bus";
import {
  CREATE_TOKEN_TAG,
  createTokenTagValue,
} from "src/resources/utils/create-token";

const arn = "arn:aws:events:eu-west-2:123456789012:event-bus/orders";

const bus = new EventBus("orders-bus", { config: { Name: "orders" } });
const defaultBus = new DefaultEventBus("default-bus", {
  config: { Name: "default" },
});

const notFound = () =>
  new sdk.ResourceNotFoundException({ message: "missing", $metadata: {} });

function mockSend(respond: (command: unknown) => unknown) {
  return vi
    .spyOn(eventBridgeClient(), "send")
    .mockImplementation(async (command) => respond(command));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EventBridge event bus", () => {
  it("creates the bus with its name", async () => {
    const send = mockSend(() => ({ EventBusArn: arn }));

    await bus.create({ Name: "orders" });

    const command = send.mock.calls[0]![0] as sdk.CreateEventBusCommand;
    expect(command).toBeInstanceOf(sdk.CreateEventBusCommand);
    expect(command.input).toEqual({ Name: "orders" });
  });

  it("tags the bus with the create attempt's token", async () => {
    const send = mockSend(() => ({ EventBusArn: arn }));

    await bus.create({ Name: "orders" }, undefined, "token-1");

    const command = send.mock.calls[0]![0] as sdk.CreateEventBusCommand;
    expect(command.input).toEqual({
      Name: "orders",
      Tags: [{ Key: CREATE_TOKEN_TAG, Value: createTokenTagValue("token-1") }],
    });
  });

  it("finds the bus that has the create token", async () => {
    const send = mockSend((command) => {
      if (command instanceof sdk.DescribeEventBusCommand) {
        return { Name: "orders", Arn: arn };
      }
      return {
        Tags: [
          { Key: CREATE_TOKEN_TAG, Value: createTokenTagValue("token-1") },
        ],
      };
    });

    await expect(bus.find!({ Name: "orders" }, "token-1")).resolves.toBe(
      undefined,
    );
    const tagsCommand = send.mock
      .calls[1]![0] as sdk.ListTagsForResourceCommand;
    expect(tagsCommand.input).toEqual({ ResourceARN: arn });
  });

  it("reports a bus with the same name and another token as not found", async () => {
    mockSend((command) => {
      if (command instanceof sdk.DescribeEventBusCommand) {
        return { Name: "orders", Arn: arn };
      }
      return {
        Tags: [{ Key: CREATE_TOKEN_TAG, Value: createTokenTagValue("other") }],
      };
    });

    await expect(bus.find!({ Name: "orders" }, "token-1")).rejects.toSatisfy(
      ResourceNotFoundError.is,
    );
  });

  it("reports a missing bus as not found by find", async () => {
    mockSend(() => {
      throw notFound();
    });

    await expect(bus.find!({ Name: "orders" }, "token-1")).rejects.toSatisfy(
      ResourceNotFoundError.is,
    );
  });

  it("proves its ownership by its create token", () => {
    expect(bus.ownership).toBe("token");
  });

  it("reports a create that may have taken effect as unknown", async () => {
    mockSend(() => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });

    await expect(bus.create({ Name: "orders" })).rejects.toBeInstanceOf(
      ResourceCreationUnknownError,
    );
  });

  it("reports a bus that already exists as ResourceAlreadyExistsError", async () => {
    mockSend(() => {
      throw new sdk.ResourceAlreadyExistsException({
        message: "Event bus orders already exists.",
        $metadata: {},
      });
    });

    await expect(bus.create({ Name: "orders" })).rejects.toBeInstanceOf(
      ResourceAlreadyExistsError,
    );
  });

  it("reads the bus's name and ARN", async () => {
    mockSend(() => ({ Name: "orders", Arn: arn, Policy: "{}" }));

    await expect(bus.read!({ Name: "orders" })).resolves.toEqual({
      Name: "orders",
      Arn: arn,
    });
  });

  it("reports a missing bus as not found", async () => {
    mockSend(() => {
      throw notFound();
    });

    await expect(bus.read!({ Name: "orders" })).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it("deletes the bus, and succeeds when it is gone", async () => {
    const send = mockSend(() => {
      throw notFound();
    });

    await expect(bus.delete({ Name: "orders" }, {} as any)).resolves.toBe(
      undefined,
    );
    expect(send.mock.calls[0]![0]).toBeInstanceOf(sdk.DeleteEventBusCommand);
  });
});

describe("EventBridge default event bus", () => {
  it("reads the default bus to create it, and makes no change", async () => {
    const send = mockSend(() => ({
      Name: "default",
      Arn: "arn:aws:events:eu-west-2:123456789012:event-bus/default",
    }));

    await defaultBus.create({ Name: "default" });

    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
      sdk.DescribeEventBusCommand,
    ]);
  });

  it("never deletes the default bus", async () => {
    const send = mockSend(() => ({}));

    await defaultBus.delete({ Name: "default" }, {} as any);

    expect(send).not.toHaveBeenCalled();
  });
});
