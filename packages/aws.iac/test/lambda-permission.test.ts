import { expect, test, vi } from "vitest";
import { LambdaApiGatewayV2Permission } from "src/resources/lambda/lambda-api-permission";
import { LambdaEventBridgeRulePermission } from "src/resources/event-bridge/lambda-permission";
import { statementId } from "src/utils/statement-id";

vi.mock("src/context", () => ({
  getAwsAccountId: async () => "123456789012",
}));

const fn = { output: { FunctionName: "app--prod--orders" } } as any;

test("a function routed from two APIs gets a statement per API", async () => {
  const statementOf = async (ApiId: string) =>
    (
      await new LambdaApiGatewayV2Permission("p", {
        dependencies: { lambda: fn, api: { output: { ApiId } } as any },
      }).getParams()
    ).StatementId;

  expect(await statementOf("a1b2c3d4e5")).toBe("apigateway-a1b2c3d4e5");
  expect(await statementOf("f6g7h8i9j0")).toBe("apigateway-f6g7h8i9j0");
});

test("a function on two schedules gets a statement per rule", async () => {
  const statementOf = async (Name: string) =>
    (
      await new LambdaEventBridgeRulePermission("p", {
        dependencies: {
          lambda: fn,
          eventBridgeRule: { output: { Name, Arn: `arn:${Name}` } } as any,
        },
      }).getParams()
    ).StatementId;

  expect(await statementOf("app--prod--daily")).toBe("events-app--prod--daily");
  expect(await statementOf("app--prod--hourly")).toBe(
    "events-app--prod--hourly",
  );
});

test("a StatementId replaces characters that Lambda doesn't allow", () => {
  expect(statementId("events", "my.rule")).toBe("events-my_rule");
});

test("a StatementId longer than 100 characters throws", () => {
  expect(() => statementId("events", "a".repeat(94))).toThrow(
    "longer than 100 characters",
  );
});
