import { resolveLambdaTarget, type LambdaTarget } from "src/lambda";
import type { EventBridgeHandler } from "src/shared";
import { Schedule } from "./schedule";
import * as aws from "@notation/aws.iac";
import { toAwsScheduleExpression } from "./aws-conversions";
import { awsName } from "src/naming";

type ScheduleConfig = {
  name: string;
  schedule: Schedule;
  /**
   * The export of a runtime module to invoke on the schedule, or a Lambda
   * group from `lambda()`.
   */
  handler: LambdaTarget<EventBridgeHandler<"Scheduled Event", any>>;
};

export class ScheduleGroup extends aws.AwsResourceGroup<ScheduleConfig> {
  readonly rule: aws.eventBridge.EventBridgeRuleInstance;

  constructor(config: ScheduleConfig) {
    const target = resolveLambdaTarget(config.handler, "schedule()");
    super("aws/eventBridge/schedule", config.name, config);

    const lambdaGroup = target.group;
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
              // A bare group runs external code, which gets the event as it is.
              InputTransformer:
                target.export === undefined
                  ? undefined
                  : {
                      InputTemplate: scheduledInvocationTemplate(target.export),
                    },
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
 * The rule depends on the function, so the function can't hold the rule's
 * ARN in its dispatch map without a cycle. Instead the rule sends a
 * `ScheduledInvocation`: the export to call, and the original event, which
 * EventBridge puts in place of `<aws.events.event.json>`.
 */
function scheduledInvocationTemplate(exportName: string): string {
  return `{"export":${JSON.stringify(exportName)},"event":<aws.events.event.json>}`;
}

export const schedule = (config: ScheduleConfig) => new ScheduleGroup(config);
