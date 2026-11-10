import * as aws from "src/resources";
import { AwsResourceGroup } from "src/resource-group";
import { perCollection } from "@notation/resource";
import type { EventBusSource, RuleOptions } from "src/lambda/declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import { assertId, assertName, resourceId, type NameSafe } from "src/id";
import { awsName, claimAwsName, describeDeclaration } from "src/naming";
import { RuleGroup } from "./rule-group";

export type EventBusConfig = {
  /**
   * Keys the bus in state. Changing the id replaces the bus, so keep it
   * stable. Must be name-safe: 1 to 64 letters, digits, hyphens or
   * underscores.
   */
  id: string;
  /**
   * The bus's name in AWS, in place of the id. The bus is named
   * `<app>--<stage>--<name>`. Changing the name replaces the bus. Must be
   * name-safe.
   */
  name?: string;
};

export type EventBusAction = "PutEvents";

/** An event bus from `eventBus()` or `defaultEventBus()`. */
export abstract class EventBus<C extends Record<string, any> = {}>
  extends AwsResourceGroup<C>
  implements EventBusSource
{
  abstract readonly bus:
    aws.eventBridge.EventBusInstance | aws.eventBridge.DefaultEventBusInstance;

  /** The bus's ARN. It is an output value, filled in at deploy. */
  get arn(): string {
    return this.bus.outputValue("Arn");
  }

  /** The bus's name. It is an output value, filled in at deploy. */
  get name(): string {
    return this.bus.outputValue("Name");
  }

  /** A policy statement that allows the actions on this bus. */
  grant(actions: EventBusAction[]): aws.lambda.PolicyStatement {
    return {
      Effect: "Allow",
      Action: actions.map((action) => `events:${action}`),
      Resource: this.arn,
    };
  }

  /**
   * Makes a rule on the bus that targets a Lambda, for
   * `eventBridge.bind(bus).defineRule()` in a declaration.
   */
  "~rule"(lambdaGroup: LambdaGroup, options: RuleOptions): void {
    new RuleGroup(
      this,
      options,
      lambdaGroup,
      "eventBridge.bind(bus).defineRule()",
    );
  }
}

export class EventBusGroup extends EventBus<EventBusConfig> {
  readonly bus: aws.eventBridge.EventBusInstance;

  constructor(config: EventBusConfig) {
    assertId("eventBus()", config.id);
    assertName("eventBus()", config.name);
    const busName = awsName("eventBridgeBus", config.name ?? config.id);
    super("aws/eventBridge/eventBus", config.id, config);
    claimAwsName(
      "EventBridge event buses",
      busName,
      describeDeclaration("eventBus()", config.id, config.name),
    );
    this.bus = this.add(
      new aws.eventBridge.EventBus(resourceId("eventbridge-bus", config.id), {
        config: { Name: busName },
      }),
    );
  }
}

export class DefaultEventBusGroup extends EventBus {
  readonly bus: aws.eventBridge.DefaultEventBusInstance;

  constructor() {
    super("aws/eventBridge/defaultEventBus", "default");
    this.bus = this.add(
      new aws.eventBridge.DefaultEventBus("eventbridge-default-bus", {
        config: { Name: "default" },
      }),
    );
  }
}

/**
 * Declares a custom event bus. `id` must be a name-safe string literal; see
 * `NameSafe`. In a function, the bus is `{}`.
 * @resource runtime:
 */
export function eventBus<const Id extends string>(
  config: Omit<EventBusConfig, "id"> & { id: NameSafe<Id> },
): EventBusGroup {
  return new EventBusGroup(config);
}

// The default bus of each collection, so that each call returns the same
// group.
const defaultBus = perCollection(
  "@notation/aws/defaultEventBus",
  () => new DefaultEventBusGroup(),
);

/**
 * The account's default event bus, which receives the events of AWS
 * services. Notation reads its ARN, and never changes or deletes it. Each
 * call returns the same bus. In a function, the bus is `{}`.
 * @resource runtime:
 */
export function defaultEventBus(): DefaultEventBusGroup {
  return defaultBus() ?? new DefaultEventBusGroup();
}
