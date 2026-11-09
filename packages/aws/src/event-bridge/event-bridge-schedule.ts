import { resolveLambda, whenLoaded } from "src/lambda/lambda-declaration";
import type {
  EventBridgeScheduleEvent,
  ScheduleOptions,
} from "src/lambda/declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import type { NameSafe } from "src/id";
import { ScheduleGroup } from "./schedule-group";

export { ScheduleGroup };

export type ScheduleConfig = ScheduleOptions & {
  /**
   * The Lambda to invoke on the schedule: a declaration from `$lambda`,
   * passed as `() => lambda`, or a Lambda group from `lambda()`. A
   * declaration must be declared with `event: () => eventBridge.schema(null)`,
   * or with no event.
   */
  target: ScheduleTarget;
};

/** A Lambda that can receive scheduled events. */
export type ScheduleTarget =
  | (() => {
      readonly "~lambda"?:
        | { kind: "none" }
        | { kind: "eventBridge"; event: EventBridgeScheduleEvent };
    })
  | LambdaGroup;

/**
 * Invokes a Lambda on a schedule. The schedule's resources are made when
 * infra has finished loading. A declaration can make its own schedule, with
 * `event: () => eventBridge.defineSchedule(options)`. `id` must be a
 * name-safe string literal; see `NameSafe`.
 * @resource
 */
export function schedule<const Id extends string>(
  config: Omit<ScheduleConfig, "id"> & { id: NameSafe<Id> },
): void {
  const { target, id, ...options } = config;
  whenLoaded(() => {
    const { group: lambdaGroup, event } = resolveLambda(
      target,
      "schedule()",
      "eventBridge",
    );
    if (event?.kind === "eventBridge" && event.schema !== null) {
      throw new Error(
        `schedule() sends scheduled events, which have no detail, but the Lambda "${lambdaGroup.id}" is declared with event: () => eventBridge.schema(schema). Declare it with event: () => eventBridge.schema(null).`,
      );
    }
    new ScheduleGroup({ id, ...options }, lambdaGroup);
  });
}
