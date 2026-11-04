import { lambdaTarget, type HandlerTarget } from "src/lambda";
import type { EventBridgeEvent } from "aws-lambda";
import { Schedule } from "./schedule";
import * as aws from "@notation/aws.iac";
import { toAwsScheduleExpression } from "./aws-conversions";
import { awsName } from "src/naming";

type ScheduleConfig = {
  name: string;
  schedule: Schedule;
  /**
   * The handler of a runtime module to invoke on the schedule, or a Lambda
   * group from `lambda()`. A handler is wired when the runtime modules are
   * linked.
   */
  handler: HandlerTarget<EventBridgeEvent<"Scheduled Event", any>>;
};

export class ScheduleGroup extends aws.AwsResourceGroup<ScheduleConfig> {
  /** The rule. It is added once the handler is wired. */
  rule!: aws.eventBridge.EventBridgeRuleInstance;

  constructor(config: ScheduleConfig) {
    super("aws/eventBridge/schedule", config.name, config);
    lambdaTarget(config.handler, "schedule()").wire(
      "schedule",
      (fn, exportName) => {
        const lambdaResource = fn.fn;

        this.rule = this.add(
          new aws.eventBridge.EventBridgeRule(
            `${config.name}-eventbridge-rule`,
            {
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
                      exportName === undefined
                        ? undefined
                        : {
                            InputTemplate:
                              scheduledInvocationTemplate(exportName),
                          },
                  },
                ],
              },
              dependencies: {
                lambda: lambdaResource,
              },
            },
          ),
        );

        fn.add(
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
      },
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

export function schedule(config: ScheduleConfig): ScheduleGroup {
  return new ScheduleGroup(config);
}
