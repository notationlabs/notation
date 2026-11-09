import * as aws from "@notation/aws.iac";
import type { ScheduleOptions } from "src/lambda/declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import { awsName } from "src/naming";
import { toAwsScheduleExpression } from "./aws-conversions";

export class ScheduleGroup extends aws.AwsResourceGroup<ScheduleOptions> {
  readonly rule: aws.eventBridge.EventBridgeRuleInstance;

  constructor(config: ScheduleOptions, lambdaGroup: LambdaGroup) {
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
