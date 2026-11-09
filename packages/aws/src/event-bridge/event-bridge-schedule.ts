import {
  resolveLambda,
  whenLoaded,
  type LambdaTarget,
} from "src/lambda/lambda-declaration";
import type { ScheduleOptions } from "src/lambda/declaration";
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
  target: LambdaTarget<"eventBridge" | "none">;
};

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
  const { target, ...options } = config;
  whenLoaded(() => {
    const { group: lambdaGroup } = resolveLambda(
      target,
      "schedule()",
      "eventBridge",
    );
    new ScheduleGroup(options as ScheduleOptions, lambdaGroup);
  });
}
