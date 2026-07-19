import { EventBridgeHandler } from "src/shared/lambda.handler";
import { Schedule } from "./schedule";
import * as aws from "@notation/aws.iac";
import { toAwsScheduleExpression } from "./aws-conversions";

export const schedule = (config: {
  name: string;
  schedule: Schedule;
  handler:
    | EventBridgeHandler<"Scheduled Event", any>
    // todo: narrow to lambda group
    | aws.AwsResourceGroup;
}): aws.AwsResourceGroup => {
  const eventBridgeScheduleGroup = new aws.AwsResourceGroup(
    "aws/eventBridge/schedule",
    config,
  );

  // at compile time, a runtime handler import becomes an infra resource group
  const lambdaGroup = config.handler as aws.AwsResourceGroup;

  const lambdaResource = lambdaGroup.findResource(aws.lambda.LambdaFunction)!;

  const eventBridgeRule = new aws.eventBridge.EventBridgeRule({
    id: `${config.name}-eventbridge-rule`,
    config: {
      Name: config.name,
      ScheduleExpression: toAwsScheduleExpression(config.schedule),
      EventBusName: "default",
    },
    dependencies: {
      lambda: lambdaResource,
    },
  });

  eventBridgeScheduleGroup.add(eventBridgeRule);

  const permission = lambdaGroup.findResource(
    aws.eventBridge.LambdaEventBridgeRulePermission,
  );

  if (!permission) {
    lambdaGroup.add(
      new aws.eventBridge.LambdaEventBridgeRulePermission({
        id: `${config.name}-eventbridge-permission`,
        dependencies: {
          lambda: lambdaResource,
          eventBridgeRule: eventBridgeRule,
        },
      }),
    );
  }

  return eventBridgeScheduleGroup;
};
