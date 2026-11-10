import * as aws from "@notation/aws.iac";
import type { ScheduleOptions } from "src/lambda/declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import { assertId, assertName, resourceId } from "src/id";
import { awsName, claimAwsName, describeDeclaration } from "src/naming";
import { toAwsScheduleExpression } from "./aws-conversions";

export class ScheduleGroup extends aws.AwsResourceGroup<ScheduleOptions> {
  readonly rule: aws.eventBridge.EventBridgeRuleInstance;

  constructor(
    config: ScheduleOptions,
    lambdaGroup: LambdaGroup,
    /** Names the function that declares the schedule, in errors. */
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
      new aws.eventBridge.EventBridgeRule(
        resourceId("eventbridge-rule", config.id),
        {
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
        },
      ),
    );

    lambdaGroup.add(
      new aws.lambda.LambdaPermission(
        resourceId("eventbridge-permission", config.id),
        {
          config: {
            Action: "lambda:InvokeFunction",
            Principal: "events.amazonaws.com",
            SourceArn: this.rule.outputValue("Arn"),
          },
          dependencies: { lambda: lambdaResource },
        },
      ),
    );
  }
}
