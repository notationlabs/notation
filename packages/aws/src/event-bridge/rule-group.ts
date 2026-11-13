import * as aws from "src/resources";
import { AwsResourceGroup } from "src/resource-group";
import type { RetryOptions, RuleOptions } from "src/lambda/declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import { assertId, assertName, resourceId } from "src/id";
import { awsName, claimAwsName, describeDeclaration } from "src/naming";
import type { EventBus } from "./event-bus";

export class RuleGroup extends AwsResourceGroup<RuleOptions> {
  readonly rule: aws.eventBridge.EventBridgeRuleInstance;

  constructor(
    bus: EventBus<any>,
    config: RuleOptions,
    lambdaGroup: LambdaGroup,
    /** Names the function that declares the rule, in errors. */
    caller: string,
  ) {
    assertId(caller, config.id);
    assertName(caller, config.name);
    assertPattern(caller, config.id, config.pattern);
    if (config.retry) assertRetry(caller, config.id, config.retry);
    // Without a name, deploy generates one, which no other rule has.
    const ruleName =
      config.name === undefined
        ? undefined
        : awsName("eventBridgeRule", config.name);
    super("aws/eventBridge/rule", config.id, config);
    // AWS names rules uniquely on each bus, but the name is claimed across
    // buses, and schedules claim the same names. Nothing depends on this, so
    // the claim could be limited to each bus.
    if (ruleName !== undefined) {
      claimAwsName(
        "EventBridge rules",
        ruleName,
        describeDeclaration(caller, config.id, config.name),
      );
    }

    const lambdaResource = lambdaGroup.fn;
    const { retry } = config;

    this.rule = this.add(
      new aws.eventBridge.EventBridgeRule(
        resourceId("eventbridge-pattern-rule", config.id),
        {
          config: {
            Name: ruleName,
            // A name in the bus's config is known at plan. A generated
            // name is known only once the bus exists.
            EventBusName: bus.bus.config.Name ?? bus.name,
            EventPattern: JSON.stringify(config.pattern),
            State: config.enabled === false ? "DISABLED" : "ENABLED",
            Targets: [
              {
                Id: lambdaResource.outputRef("FunctionName"),
                Arn: lambdaResource.outputRef("FunctionArn"),
                ...(retry && { RetryPolicy: retryPolicy(retry) }),
              },
            ],
          },
          dependencies: { lambda: lambdaResource, eventBus: bus.bus },
        },
      ),
    );

    lambdaGroup.add(
      new aws.lambda.LambdaPermission(
        resourceId("eventbridge-pattern-permission", config.id),
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

// An unset option is sent as EventBridge's default. Drift compares the
// rule's targets with the targets that EventBridge lists, so the retry policy
// matches whether EventBridge lists an unset field as absent or as its
// default.
function retryPolicy({ maxAttempts, maxEventAge }: RetryOptions) {
  return {
    MaximumRetryAttempts: maxAttempts ?? 185,
    MaximumEventAgeInSeconds: maxEventAge ?? 86_400,
  };
}

function assertPattern(caller: string, id: string, pattern: unknown): void {
  if (
    typeof pattern !== "object" ||
    pattern === null ||
    Array.isArray(pattern) ||
    Object.keys(pattern).length === 0
  ) {
    throw new Error(
      `${caller} with id "${id}" needs a pattern that names at least one field, such as { source: ["shop"] }.`,
    );
  }
}

// EventBridge rejects these values only at deploy, in PutTargets.
function assertRetry(caller: string, id: string, retry: RetryOptions): void {
  const { maxAttempts, maxEventAge } = retry;
  if (
    maxAttempts !== undefined &&
    !(Number.isInteger(maxAttempts) && maxAttempts >= 0 && maxAttempts <= 185)
  ) {
    throw new Error(
      `${caller} with id "${id}" sets retry.maxAttempts: ${maxAttempts}. EventBridge allows a whole number from 0 to 185.`,
    );
  }
  if (
    maxEventAge !== undefined &&
    !(
      Number.isInteger(maxEventAge) &&
      maxEventAge >= 60 &&
      maxEventAge <= 86_400
    )
  ) {
    throw new Error(
      `${caller} with id "${id}" sets retry.maxEventAge: ${maxEventAge}. EventBridge allows a whole number of seconds from 60 to 86,400.`,
    );
  }
}
