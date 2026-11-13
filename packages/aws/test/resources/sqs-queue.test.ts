import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-sqs";
import {
  ResourceAlreadyExistsError,
  ResourceNotFoundError,
  validateValues,
  ValueValidationError,
} from "@notation/resource";
import { decideDriftAction } from "@notation/reconciler";
import { sqsClient } from "src/resources/utils/aws-clients";
import { Queue } from "src/resources/sqs/queue";

const url = "https://sqs.eu-west-2.amazonaws.com/123456789012/orders";

const dlqArn = "arn:aws:sqs:eu-west-2:123456789012:orders-dlq";

const sourceArn = "arn:aws:sqs:eu-west-2:123456789012:orders";

const queue = new Queue("orders-queue");

const queueDoesNotExist = () =>
  new sdk.QueueDoesNotExist({ message: "missing", $metadata: {} });

function mockSend(respond: (command: unknown) => unknown) {
  return vi
    .spyOn(sqsClient(), "send")
    .mockImplementation(async (command) => respond(command));
}

/** Answers the calls of a create of a queue that does not exist yet. */
function respondToCreate(command: unknown) {
  if (command instanceof sdk.GetQueueUrlCommand) throw queueDoesNotExist();
  return { QueueUrl: url };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SQS queue", () => {
  it("creates the queue with its attributes as strings", async () => {
    const send = mockSend(respondToCreate);

    const key = await queue.create({
      QueueName: "orders",
      VisibilityTimeout: 60,
      FifoQueue: false,
    });

    expect(key).toEqual({ QueueUrl: url });
    const command = send.mock.calls[1]![0] as sdk.CreateQueueCommand;
    expect(command.input).toEqual({
      QueueName: "orders",
      Attributes: { VisibilityTimeout: "60" },
    });
  });

  it("creates the redrive policy as JSON and the FIFO attributes as strings", async () => {
    const send = mockSend(respondToCreate);

    await queue.create({
      QueueName: "orders.fifo",
      FifoQueue: true,
      ContentBasedDeduplication: true,
      DeduplicationScope: "messageGroup",
      MaximumMessageSize: 2_048,
      RedrivePolicy: { deadLetterTargetArn: dlqArn, maxReceiveCount: 3 },
    });

    const command = send.mock.calls[1]![0] as sdk.CreateQueueCommand;
    expect(command.input.Attributes).toEqual({
      FifoQueue: "true",
      ContentBasedDeduplication: "true",
      DeduplicationScope: "messageGroup",
      MaximumMessageSize: "2048",
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: 3,
      }),
    });
  });

  it("creates the queue without the empty redrive policies", async () => {
    const send = mockSend(respondToCreate);

    await queue.create({
      QueueName: "orders",
      VisibilityTimeout: 60,
      RedrivePolicy: "",
      RedriveAllowPolicy: "",
    });

    const command = send.mock.calls[1]![0] as sdk.CreateQueueCommand;
    expect(command.input.Attributes).toEqual({ VisibilityTimeout: "60" });
  });

  it("creates the redrive allow policy as JSON", async () => {
    const send = mockSend(respondToCreate);

    await queue.create({
      QueueName: "orders-dlq",
      RedriveAllowPolicy: {
        redrivePermission: "byQueue",
        sourceQueueArns: [sourceArn],
      },
    });

    const command = send.mock.calls[1]![0] as sdk.CreateQueueCommand;
    expect(command.input.Attributes).toEqual({
      RedriveAllowPolicy: JSON.stringify({
        redrivePermission: "byQueue",
        sourceQueueArns: [sourceArn],
      }),
    });
  });

  it("reports a queue that exists already as ResourceAlreadyExistsError", async () => {
    const send = mockSend(() => ({ QueueUrl: url }));

    const created = queue.create({ QueueName: "orders" });
    await expect(created).rejects.toThrow(
      "An SQS queue named orders already exists",
    );
    await expect(created).rejects.toSatisfy(ResourceAlreadyExistsError.is);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reports a queue whose attributes differ from an existing one as ResourceAlreadyExistsError", async () => {
    mockSend((command) => {
      if (command instanceof sdk.GetQueueUrlCommand) throw queueDoesNotExist();
      throw new sdk.QueueNameExists({ message: "exists", $metadata: {} });
    });

    await expect(queue.create({ QueueName: "orders" })).rejects.toSatisfy(
      ResourceAlreadyExistsError.is,
    );
  });

  it("finds the URL of the queue that has the name", async () => {
    const send = mockSend(() => ({ QueueUrl: url }));

    await expect(queue.find!({ QueueName: "orders" })).resolves.toEqual({
      QueueUrl: url,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reports a missing queue as not found by find", async () => {
    mockSend(() => {
      throw queueDoesNotExist();
    });

    await expect(queue.find!({ QueueName: "orders" })).rejects.toSatisfy(
      ResourceNotFoundError.is,
    );
  });

  it("reads the attributes as numbers", async () => {
    mockSend(() => ({
      Attributes: {
        QueueArn: "arn:aws:sqs:eu-west-2:123456789012:orders",
        VisibilityTimeout: "30",
        MessageRetentionPeriod: "345600",
        DelaySeconds: "0",
        ReceiveMessageWaitTimeSeconds: "0",
        MaximumMessageSize: "1048576",
      },
    }));

    const result = await queue.read!({ QueueUrl: url });

    expect(() =>
      validateValues(queue, queue.toResult(result), "read"),
    ).not.toThrow();
    expect(result).toEqual({
      QueueUrl: url,
      QueueArn: "arn:aws:sqs:eu-west-2:123456789012:orders",
      QueueName: "orders",
      FifoQueue: false,
      VisibilityTimeout: 30,
      MessageRetentionPeriod: 345600,
      DelaySeconds: 0,
      ReceiveMessageWaitTimeSeconds: 0,
      MaximumMessageSize: 1048576,
      RedrivePolicy: "",
      RedriveAllowPolicy: "",
      ContentBasedDeduplication: undefined,
      DeduplicationScope: undefined,
      FifoThroughputLimit: undefined,
    });
  });

  it("finds drift when the dead-letter queue was removed outside Notation", async () => {
    const withDlq = new Queue("orders-with-dlq", {
      config: {
        RedrivePolicy: { deadLetterTargetArn: dlqArn, maxReceiveCount: 3 },
      },
    });
    mockSend(() => ({
      Attributes: {
        QueueArn: "arn:aws:sqs:eu-west-2:123456789012:orders",
        VisibilityTimeout: "30",
        MessageRetentionPeriod: "345600",
        DelaySeconds: "0",
        ReceiveMessageWaitTimeSeconds: "0",
        MaximumMessageSize: "1048576",
      },
    }));

    const output = await withDlq.read!({ QueueUrl: url }, {} as any);
    const action = decideDriftAction({
      resource: withDlq,
      params: await withDlq.getParams(),
      driftRead: { kind: "present", output: output as any },
    });

    expect(action).toMatchObject({
      decision: "drift-update",
      patch: {
        RedrivePolicy: { deadLetterTargetArn: dlqArn, maxReceiveCount: 3 },
      },
    });
  });

  it("reads the redrive policy and the FIFO attributes", async () => {
    mockSend(() => ({
      Attributes: {
        QueueArn: "arn:aws:sqs:eu-west-2:123456789012:orders.fifo",
        FifoQueue: "true",
        VisibilityTimeout: "30",
        MessageRetentionPeriod: "345600",
        DelaySeconds: "0",
        ReceiveMessageWaitTimeSeconds: "0",
        MaximumMessageSize: "1048576",
        RedrivePolicy: `{"deadLetterTargetArn":"${dlqArn}","maxReceiveCount":"3"}`,
        ContentBasedDeduplication: "false",
        DeduplicationScope: "queue",
        FifoThroughputLimit: "perQueue",
      },
    }));

    const result = await queue.read!({ QueueUrl: url });

    expect(() =>
      validateValues(queue, queue.toResult(result), "read"),
    ).not.toThrow();
    expect(result).toMatchObject({
      FifoQueue: true,
      RedrivePolicy: { deadLetterTargetArn: dlqArn, maxReceiveCount: 3 },
      ContentBasedDeduplication: false,
      DeduplicationScope: "queue",
      FifoThroughputLimit: "perQueue",
    });
  });

  it("reads the redrive allow policy", async () => {
    const attributes = {
      QueueArn: dlqArn,
      VisibilityTimeout: "30",
      MessageRetentionPeriod: "345600",
      DelaySeconds: "0",
      ReceiveMessageWaitTimeSeconds: "0",
      MaximumMessageSize: "1048576",
    };
    mockSend(() => ({
      Attributes: {
        ...attributes,
        RedriveAllowPolicy: `{"redrivePermission":"byQueue","sourceQueueArns":["${sourceArn}"]}`,
      },
    }));

    const byQueue = await queue.read!({ QueueUrl: url });

    expect(() =>
      validateValues(queue, queue.toResult(byQueue), "read"),
    ).not.toThrow();
    expect(byQueue).toMatchObject({
      RedriveAllowPolicy: {
        redrivePermission: "byQueue",
        sourceQueueArns: [sourceArn],
      },
    });

    vi.restoreAllMocks();
    mockSend(() => ({
      Attributes: {
        ...attributes,
        RedriveAllowPolicy: `{"redrivePermission":"denyAll"}`,
      },
    }));

    const denyAll = await queue.read!({ QueueUrl: url });

    expect(denyAll).toMatchObject({
      RedriveAllowPolicy: { redrivePermission: "denyAll" },
    });
  });

  it("rejects a visibility timeout that SQS does not allow", () => {
    expect(
      () =>
        new Queue("bad-queue", {
          config: { VisibilityTimeout: 50_000 },
        }),
    ).toThrow(ValueValidationError);
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

  it("removes removed redrive policies, and resets the FIFO attributes", async () => {
    const send = mockSend(() => ({}));

    await queue.update!(
      { QueueUrl: url },
      {
        RedrivePolicy: undefined,
        RedriveAllowPolicy: undefined,
        MaximumMessageSize: undefined,
        ContentBasedDeduplication: undefined,
        DeduplicationScope: undefined,
        FifoThroughputLimit: undefined,
      } as any,
      { QueueName: "orders" },
      {} as any,
    );

    const command = send.mock.calls[0]![0] as sdk.SetQueueAttributesCommand;
    expect(command.input.Attributes).toEqual({
      RedrivePolicy: "",
      RedriveAllowPolicy: "",
      MaximumMessageSize: "1048576",
      ContentBasedDeduplication: "false",
      DeduplicationScope: "queue",
      FifoThroughputLimit: "perQueue",
    });
  });

  it("rejects a maxReceiveCount that SQS does not allow", () => {
    expect(
      () =>
        new Queue("bad-queue", {
          config: {
            RedrivePolicy: { deadLetterTargetArn: dlqArn, maxReceiveCount: 0 },
          },
        }),
    ).toThrow(ValueValidationError);
  });

  it("rejects a byQueue redrive allow policy without source queues", () => {
    expect(
      () =>
        new Queue("bad-queue", {
          config: {
            RedriveAllowPolicy: {
              redrivePermission: "byQueue",
              sourceQueueArns: [],
            },
          },
        }),
    ).toThrow(ValueValidationError);
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
