import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-sqs";
import { ResourceNotFoundError } from "@notation/resource";
import { sqsClient } from "src/utils/aws-clients";
import { Queue } from "src/resources/sqs/queue";
import { CREATE_TOKEN_TAG, createTokenTagValue } from "src/utils/create-token";

const url = "https://sqs.eu-west-2.amazonaws.com/123456789012/orders";

const queue = new Queue("orders-queue", { config: { QueueName: "orders" } });

const queueDoesNotExist = () =>
  new sdk.QueueDoesNotExist({ message: "missing", $metadata: {} });

function mockSend(respond: (command: unknown) => unknown) {
  return vi
    .spyOn(sqsClient, "send")
    .mockImplementation(async (command) => respond(command));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SQS queue", () => {
  it("creates the queue with its attributes as strings and the create token", async () => {
    const send = mockSend((command) => {
      if (command instanceof sdk.GetQueueUrlCommand) throw queueDoesNotExist();
      return { QueueUrl: url };
    });

    const key = await queue.create(
      { QueueName: "orders", VisibilityTimeout: 60, FifoQueue: false },
      undefined,
      "token",
    );

    expect(key).toEqual({ QueueUrl: url });
    const command = send.mock.calls[1]![0] as sdk.CreateQueueCommand;
    expect(command.input).toEqual({
      QueueName: "orders",
      Attributes: { VisibilityTimeout: "60" },
      tags: { [CREATE_TOKEN_TAG]: createTokenTagValue("token") },
    });
  });

  it("does not take over a queue that exists already", async () => {
    const send = mockSend(() => ({ QueueUrl: url }));

    await expect(queue.create({ QueueName: "orders" })).rejects.toThrow(
      "An SQS queue named orders already exists",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("finds the queue that has the create token", async () => {
    mockSend((command) => {
      if (command instanceof sdk.GetQueueUrlCommand) return { QueueUrl: url };
      return { Tags: { [CREATE_TOKEN_TAG]: createTokenTagValue("token") } };
    });

    await expect(
      queue.find!({ QueueName: "orders" }, "token"),
    ).resolves.toEqual({ QueueUrl: url });
  });

  it("reports a queue without the create token as not found", async () => {
    mockSend((command) => {
      if (command instanceof sdk.GetQueueUrlCommand) return { QueueUrl: url };
      return { Tags: {} };
    });

    await expect(
      queue.find!({ QueueName: "orders" }, "token"),
    ).rejects.toSatisfy(ResourceNotFoundError.is);
  });

  it("reads the attributes as numbers", async () => {
    mockSend(() => ({
      Attributes: {
        QueueArn: "arn:aws:sqs:eu-west-2:123456789012:orders",
        VisibilityTimeout: "30",
        MessageRetentionPeriod: "345600",
        DelaySeconds: "0",
        ReceiveMessageWaitTimeSeconds: "0",
      },
    }));

    expect(await queue.read!({ QueueUrl: url })).toEqual({
      QueueUrl: url,
      QueueArn: "arn:aws:sqs:eu-west-2:123456789012:orders",
      QueueName: "orders",
      FifoQueue: false,
      VisibilityTimeout: 30,
      MessageRetentionPeriod: 345600,
      DelaySeconds: 0,
      ReceiveMessageWaitTimeSeconds: 0,
    });
  });

  it("resets a removed attribute to the API's default", async () => {
    const send = mockSend(() => ({}));

    await queue.update!(
      { QueueUrl: url },
      { VisibilityTimeout: undefined, DelaySeconds: 5 } as any,
      { QueueName: "orders", DelaySeconds: 5 },
      {} as any,
    );

    const command = send.mock.calls[0]![0] as sdk.SetQueueAttributesCommand;
    expect(command.input).toEqual({
      QueueUrl: url,
      Attributes: { VisibilityTimeout: "30", DelaySeconds: "5" },
    });
  });

  it("reports a missing queue as not found", async () => {
    mockSend(() => {
      throw queueDoesNotExist();
    });

    await expect(queue.read!({ QueueUrl: url })).rejects.toSatisfy(
      ResourceNotFoundError.is,
    );
  });
});
