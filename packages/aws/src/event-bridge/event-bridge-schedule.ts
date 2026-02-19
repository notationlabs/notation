import type { ResourceCollector, ResourceGroup } from "@notation/core";
import { EventBridgeHandler } from "src/shared/lambda.handler";
import { Schedule } from "./schedule";
import { lambda } from "src/lambda";
import * as aws from "@notation/aws.iac";
import { toAwsScheduleExpression } from "./aws-conversions";

export const schedule = (
  collector: ResourceCollector,
  config: {
    name: string;
    schedule: Schedule;
    handler: EventBridgeHandler<"Scheduled Event", any>;
  },
): ResourceGroup => {
  const eventBridgeScheduleGroup = new aws.AwsResourceGroup(
    "aws/eventBridge/schedule",
    {
      ...config,
      collector,
    },
  );

  // at compile time becomes infra module
  const lambdaGroup = config.handler as any as ReturnType<typeof lambda>;
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
