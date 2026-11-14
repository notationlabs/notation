import * as eventBridge from "@aws-sdk/client-eventbridge";
import * as lambda from "@aws-sdk/client-lambda";
import { expect, it } from "vitest";
import {
  busesWithPrefix,
  clients,
  describeE2e,
  functionsWithPrefix,
  ruleNames,
  ruleTargets,
  useProject,
} from "../e2e";

describeE2e("EventBus", () => {
  const project = useProject();
  let functionArn: string;
  let oldBus: string;
  let oldRule: string;

  // The rule's resource ID comes from the rule's id, so a new bus id gives
  // the rule a new EventBusName, which is immutable, and the rule is
  // replaced. The bus's only param is its generated name, so no change in
  // config replaces the bus in place.
  function writeProject(busId: string) {
    project.write(
      "runtime/target.ts",
      `
      import { $lambda, type LambdaHandler } from "@notation/aws/lambda";

      export const lambda = $lambda({ id: "target" });

      export const handler: LambdaHandler<typeof lambda> = async () => {};
      `,
    );
    project.write(
      "infra/main.ts",
      `
      import { eventBus, rule } from "@notation/aws/event-bridge";
      import { lambda } from "../runtime/target";

      const bus = eventBus({ id: "${busId}" });

      rule({
        id: "shipped",
        bus,
        pattern: { source: ["ne2e"] },
        target: () => lambda,
      });
      `,
    );
  }

  async function onlyBusAndRule(): Promise<{ bus: string; rule: string }> {
    const buses = await busesWithPrefix(project.scope);
    expect(buses).toHaveLength(1);
    const rules = await ruleNames(buses[0]!);
    expect(rules).toHaveLength(1);
    const targets = await ruleTargets(buses[0]!, rules[0]!);
    expect(targets.map((target) => target.Arn)).toEqual([functionArn]);
    return { bus: buses[0]!, rule: rules[0]! };
  }

  async function busExists(name: string): Promise<boolean> {
    try {
      await clients.eventBridge.send(
        new eventBridge.DescribeEventBusCommand({ Name: name }),
      );
      return true;
    } catch (error) {
      if (error instanceof eventBridge.ResourceNotFoundException) return false;
      throw error;
    }
  }

  it("creates a bus with a rule that targets a function", async () => {
    writeProject("orders");
    await project.notation("deploy");

    const functions = await functionsWithPrefix(project.scope);
    expect(functions).toHaveLength(1);
    const config = await clients.lambda.send(
      new lambda.GetFunctionConfigurationCommand({
        FunctionName: functions[0],
      }),
    );
    functionArn = config.FunctionArn!;
    ({ bus: oldBus, rule: oldRule } = await onlyBusAndRule());
  });

  it("moves the rule to a new bus, and deletes the old rule and the old bus", async () => {
    writeProject("orders-2");
    await project.notation("deploy");

    const { bus, rule } = await onlyBusAndRule();
    expect(bus).not.toBe(oldBus);
    expect(rule).not.toBe(oldRule);
    expect(await busExists(oldBus)).toBe(false);
  });

  it("destroys the bus, the rule and the function", async () => {
    await project.notation("destroy");

    expect(await busesWithPrefix(project.scope)).toEqual([]);
    expect(await functionsWithPrefix(project.scope)).toEqual([]);
  });
});
