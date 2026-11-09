import * as aws from "@notation/aws.iac";
import type { ScheduleOptions } from "src/lambda/declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import { assertId, assertName } from "src/id";
import { awsName, claimAwsName, describeDeclaration } from "src/naming";
import { toAwsScheduleExpression } from "./aws-conversions";

export class ScheduleGroup extends aws.AwsResourceGroup<ScheduleOptions> {
  readonly rule: aws.eventBridge.EventBridgeRuleInstance;

  /** `caller` names the function that declares the schedule, in errors. */
  constructor(
    config: ScheduleOptions,
    lambdaGroup: LambdaGroup,
    caller = "schedule()",
  ) {
    assertId(caller, config.id);
    assertName(caller, config.name);
    const ruleName = awsName("eventBridgeRule", config.name ?? config.id);
    super("aws/eventBridge/schedule", config.id, config);
    claimAwsName(
      "EventBridge rules",
      ruleName,
      describeDeclaration(caller, config.id, config.name),
    );

    const lambdaResource = lambdaGroup.fn;

    this.rule = this.add(
      new aws.eventBridge.EventBridgeRule(`${config.id}-eventbridge-rule`, {
        config: {
          Name: ruleName,
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
        `${config.id}-eventbridge-permission`,
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
