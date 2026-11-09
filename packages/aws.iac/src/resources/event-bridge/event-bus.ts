import * as v from "valibot";
import { resource, ResourceNotFoundError } from "@notation/resource";
import * as sdk from "@aws-sdk/client-eventbridge";
import { eventBridgeClient } from "src/utils/aws-clients";
import { awsCreate } from "src/utils/errors";
import { AwsSchema } from "src/utils/types";

export type EventBusSchema = AwsSchema<{
  Key: { Name: string };
  CreateParams: { Name: string };
  ReadResult: { Name: string; Arn: string };
}>;

const eventBus = resource<EventBusSchema>({
  type: "aws/eventBridge/EventBus",
});

const eventBusSchema = eventBus.defineSchema({
  Name: {
    propertyType: "param",
    presence: "required",
    primaryKey: true,
    value: v.string(),
  },
  Arn: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
} as const);

/** A custom event bus. */
export const EventBus = eventBusSchema.defineOperations({
  // CreateEventBus fails for a name that is taken, so a bus that exists
  // already is reported, instead of being taken over. The key is the name,
  // so the reconciler finds a bus whose create outcome is unknown by reading
  // it.
  create: awsCreate(async (params) => {
    try {
      await eventBridgeClient().send(
        new sdk.CreateEventBusCommand({ Name: params.Name }),
      );
    } catch (error) {
      if (error instanceof sdk.ResourceAlreadyExistsException) {
        throw new Error(
          `An EventBridge event bus named ${params.Name} already exists`,
          { cause: error },
        );
      }
      throw error;
    }
  }),

  read: async (key) => describeEventBus(key.Name),

  delete: async (key) => {
    try {
      await eventBridgeClient().send(
        new sdk.DeleteEventBusCommand({ Name: key.Name }),
      );
    } catch (error) {
      if (!(error instanceof sdk.ResourceNotFoundException)) throw error;
    }
  },
});

export type EventBusInstance = InstanceType<typeof EventBus>;

const defaultEventBus = resource<EventBusSchema>({
  type: "aws/eventBridge/DefaultEventBus",
});

const defaultEventBusSchema = defaultEventBus.defineSchema({
  Name: {
    propertyType: "param",
    presence: "required",
    primaryKey: true,
    value: v.literal("default"),
  },
  Arn: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
} as const);

/**
 * The account's default event bus, which AWS makes. Notation reads it, so
 * that other resources can use its ARN, and never changes or deletes it.
 */
export const DefaultEventBus = defaultEventBusSchema.defineOperations({
  create: async (params) => {
    await describeEventBus(params.Name);
  },
  read: async (key) => describeEventBus(key.Name),
  delete: async () => {},
});

export type DefaultEventBusInstance = InstanceType<typeof DefaultEventBus>;

async function describeEventBus(
  Name: string,
): Promise<{ Name: string; Arn: string }> {
  try {
    const result = await eventBridgeClient().send(
      new sdk.DescribeEventBusCommand({ Name }),
    );
    return { Name: result.Name!, Arn: result.Arn! };
  } catch (error) {
    if (error instanceof sdk.ResourceNotFoundException) {
      throw new ResourceNotFoundError("EventBridge event bus was not found", {
        cause: error,
      });
    }
    throw error;
  }
}
