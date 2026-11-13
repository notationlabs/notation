import * as aws from "src/resources";
import { AwsResourceGroup } from "src/resource-group";
import type { ScheduleOptions } from "src/lambda/declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import { assertId, assertName, resourceId } from "src/id";
import { awsName, claimAwsName, describeDeclaration } from "src/naming";
import { toAwsScheduleExpression } from "./aws-conversions";

export class ScheduleGroup extends AwsResourceGroup<ScheduleOptions> {
  readonly rule: aws.eventBridge.EventBridgeRuleInstance;

  constructor(
    config: ScheduleOptions,
    lambdaGroup: LambdaGroup,
    /** Names the function that declares the schedule, in errors. */
    caller = "schedule()",
  ) {
    assertId(caller, config.id);
    assertName(caller, config.name);
    // Without a name, deploy generates one, which no other rule has.
    const ruleName =
      config.name === undefined
        ? undefined
        : awsName("eventBridgeRule", config.name);
    super("aws/eventBridge/schedule", config.id, config);
    if (ruleName !== undefined) {
      claimAwsName(
        "EventBridge rules",
        ruleName,
        describeDeclaration(caller, config.id, config.name),
      );
    }

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
                Id: lambdaResource.outputRef("FunctionName"),
                Arn: lambdaResource.outputRef("FunctionArn"),
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
            SourceArn: this.rule.outputRef("Arn"),
          },
          dependencies: { lambda: lambdaResource },
        },
      ),
    );
  }
}
