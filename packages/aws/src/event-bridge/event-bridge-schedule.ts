import { EventBridgeHandler } from "src/shared/lambda.handler";
import type { LambdaGroup } from "src/lambda";
import { Schedule } from "./schedule";
import * as aws from "@notation/aws.iac";
import { toAwsScheduleExpression } from "./aws-conversions";

type ScheduleConfig = {
  name: string;
  schedule: Schedule;
  handler: EventBridgeHandler<"Scheduled Event", any> | LambdaGroup;
};

export class ScheduleGroup extends aws.AwsResourceGroup<ScheduleConfig> {
  readonly rule: aws.eventBridge.EventBridgeRuleInstance;

  constructor(config: ScheduleConfig) {
    super("aws/eventBridge/schedule", config.name, config);

    // at compile time, a runtime handler import becomes a lambda group
    const lambdaGroup = config.handler as LambdaGroup;
    const lambdaResource = lambdaGroup.fn;

    this.rule = this.add(
      new aws.eventBridge.EventBridgeRule(`${config.name}-eventbridge-rule`, {
        config: {
          Name: config.name,
          ScheduleExpression: toAwsScheduleExpression(config.schedule),
          EventBusName: "default",
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

export const schedule = (config: ScheduleConfig) => new ScheduleGroup(config);
