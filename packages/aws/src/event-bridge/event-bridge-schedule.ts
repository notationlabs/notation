import {
  resolveLambda,
  whenLoaded,
  type LambdaTarget,
} from "src/lambda/lambda-declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import { Schedule } from "./schedule";
import * as aws from "@notation/aws.iac";
import { toAwsScheduleExpression } from "./aws-conversions";
import { awsName } from "src/naming";

type ScheduleConfig = {
  name: string;
  schedule: Schedule;
  /**
   * The Lambda to invoke on the schedule: a declaration from `$lambda`,
   * passed as `() => lambda`, or a Lambda group from `lambda()`.
   */
  target: LambdaTarget<"scheduled" | "none">;
};

export class ScheduleGroup extends aws.AwsResourceGroup<ScheduleConfig> {
  readonly rule: aws.eventBridge.EventBridgeRuleInstance;

  constructor(config: ScheduleConfig, lambdaGroup: LambdaGroup) {
    super("aws/eventBridge/schedule", config.name, config);

    const lambdaResource = lambdaGroup.fn;

    this.rule = this.add(
      new aws.eventBridge.EventBridgeRule(`${config.name}-eventbridge-rule`, {
        config: {
          Name: awsName("eventBridgeRule", config.name),
          ScheduleExpression: toAwsScheduleExpression(config.schedule),
          EventBusName: "default",
          Targets: [
            {
              Id: lambdaResource.outputValue("FunctionName"),
              Arn: lambdaResource.outputValue("FunctionArn"),
            },
          ],
        },
        dependencies: {
          lambda: lambdaResource,
        },
      }),
    );

    lambdaGroup.add(
      new aws.eventBridge.LambdaEventBridgeRulePermission(
        `${config.name}-eventbridge-permission`,
        {
          dependencies: {
            lambda: lambdaResource,
            eventBridgeRule: this.rule,
          },
        },
      ),
    );
  }
}

/**
 * Invokes a Lambda on a schedule. The schedule's resources are made when
 * infra has finished loading.
 * @resource
 */
export function schedule(config: ScheduleConfig): void {
  whenLoaded(() => {
    const lambdaGroup = resolveLambda(config.target, "schedule()", [
      "scheduled",
      "none",
    ]);
    new ScheduleGroup(config, lambdaGroup);
  });
}
