import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-eventbridge";
import {
  ResourceCreationUnknownError,
  ResourceNotFoundError,
} from "@notation/resource";
import { eventBridgeClient } from "src/utils/aws-clients";
import {
  DefaultEventBus,
  EventBus,
} from "src/resources/event-bridge/event-bus";

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

  it("reports a create that may have taken effect as unknown", async () => {
    mockSend(() => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });

    await expect(bus.create({ Name: "orders" })).rejects.toBeInstanceOf(
      ResourceCreationUnknownError,
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
