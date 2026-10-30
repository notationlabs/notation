import { scopedPhysicalName, type PhysicalNameRule } from "@notation/resource";

/**
 * The length limits of the AWS names that Notation generates. App, stage and
 * id characters are already valid in every one of them.
 */
const rules = {
  // [a-zA-Z0-9-_]
  lambdaFunction: { maxLength: 64 },
  // [\w+=,.@-], unique regardless of case
  iamRole: { maxLength: 64 },
  // [a-zA-Z0-9-_], a FIFO queue's name ends in .fifo
  sqsQueue: { maxLength: 80, requiredEnding: ".fifo" },
  // [.\-_A-Za-z0-9], unique per event bus
  eventBridgeRule: { maxLength: 64 },
  // any characters, and not unique
  apiGatewayApi: { maxLength: 128 },
} satisfies Record<string, PhysicalNameRule>;

/**
 * Makes the AWS name of a resource from its id: `<app>-<stage>-<id>`,
 * shortened with a hash when it is too long for the service.
 */
export function awsName(kind: keyof typeof rules, id: string): string {
  return scopedPhysicalName(id, rules[kind]);
}
