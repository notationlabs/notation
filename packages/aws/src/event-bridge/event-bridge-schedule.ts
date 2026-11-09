import {
  declarationOf,
  eventCall,
  resolveLambda,
  whenLoaded,
  type LambdaTarget,
} from "src/lambda/lambda-declaration";
import type { ScheduleOptions } from "src/lambda/declaration";
import { ScheduleGroup } from "./schedule-group";

export { ScheduleGroup };

export type ScheduleConfig = ScheduleOptions & {
  /**
   * The Lambda to invoke on the schedule: a declaration from `$lambda`,
   * passed as `() => lambda`, or a Lambda group from `lambda()`. A
   * declaration must be declared with `event: () => eventBridge.schedule()`,
   * or with no event.
   */
  target: LambdaTarget<"eventBridge" | "none">;
};

/**
 * Invokes a Lambda on a schedule. The schedule's resources are made when
 * infra has finished loading. A declaration can make its own schedule, with
 * `event: () => eventBridge.defineSchedule(options)`.
 * @resource
 */
export function schedule(config: ScheduleConfig): void {
  const { target, ...options } = config;
  whenLoaded(() => {
    const declaration = declarationOf(target);
    const event = declaration?.event;
    if (event?.kind === "eventBridge" && event.schedule) {
      throw new Error(
        `schedule() invokes the Lambda "${declaration!.id}" on the schedule "${options.name}", but the Lambda makes its own schedule in its declaration, with event: () => ${eventCall(event)}. Schedule the Lambda in one place: remove the schedule() call, or declare the Lambda with event: () => eventBridge.schedule().`,
      );
    }
    const lambdaGroup = resolveLambda(target, "schedule()", [
      "eventBridge",
      "none",
    ]);
    new ScheduleGroup(options, lambdaGroup);
  });
}
