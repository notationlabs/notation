import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-iam";
import { createPlan } from "@notation/reconciler";
import { MemoryStateBackend } from "@notation/state";
import { iamClient } from "src/utils/aws-clients";
import {
  LambdaRolePolicy,
  type PolicyStatement,
} from "src/resources/lambda/lambda-role-policy";
import { LambdaIamRole } from "src/resources/lambda/lambda-role";

const orders: PolicyStatement = {
  Effect: "Allow",
  Action: ["sqs:ReceiveMessage"],
  Resource: "arn:aws:sqs:eu-west-2:123456789012:orders",
};

const refunds: PolicyStatement = {
  ...orders,
  Resource: "arn:aws:sqs:eu-west-2:123456789012:refunds",
};

function createPolicy(
  role = new LambdaIamRole("app-role", { config: { RoleName: "app-role" } }),
) {
  return new LambdaRolePolicy("app-role-policy", {
    config: { RoleName: "app-role", PolicyName: "app-role-policy" },
    dependencies: { role },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LambdaRolePolicy document", () => {
  it("concatenates the contributed statements", async () => {
    const policy = createPolicy();
    policy.contribute({ PolicyDocument: { Statement: [orders] } });
    policy.contribute({ PolicyDocument: { Statement: [refunds] } });

    expect((await policy.getParams()).PolicyDocument).toEqual({
      Version: "2012-10-17",
      Statement: [orders, refunds],
    });
  });

  it("gives the same document whatever order the contributions arrive in", async () => {
    const first = createPolicy();
    first.contribute({ PolicyDocument: { Statement: [orders] } });
    first.contribute({ PolicyDocument: { Statement: [refunds] } });
    const second = createPolicy();
    second.contribute({ PolicyDocument: { Statement: [refunds] } });
    second.contribute({ PolicyDocument: { Statement: [orders] } });

    expect(await second.getParams()).toEqual(await first.getParams());
  });

  it("sends the document as JSON", async () => {
    const policy = createPolicy();
    policy.contribute({ PolicyDocument: { Statement: [orders] } });
    const send = vi
      .spyOn(iamClient, "send")
      .mockImplementation(async () => ({}));

    await policy.create(await policy.getParams());

    const command = send.mock.calls[0]![0] as sdk.PutRolePolicyCommand;
    expect(command).toBeInstanceOf(sdk.PutRolePolicyCommand);
    expect(JSON.parse(command.input.PolicyDocument!)).toEqual({
      Version: "2012-10-17",
      Statement: [orders],
    });
  });

  it("replaces the whole document on update, so a removed statement is removed", async () => {
    const policy = createPolicy();
    policy.contribute({ PolicyDocument: { Statement: [orders] } });
    const params = await policy.getParams();
    const send = vi
      .spyOn(iamClient, "send")
      .mockImplementation(async () => ({}));

    await policy.update!(
      { RoleName: "app-role", PolicyName: "app-role-policy" },
      { PolicyDocument: params.PolicyDocument } as typeof params,
      params,
      {} as any,
    );

    const command = send.mock.calls[0]![0] as sdk.PutRolePolicyCommand;
    expect(JSON.parse(command.input.PolicyDocument!).Statement).toEqual([
      orders,
    ]);
  });

  it("does not send a document with no statements", async () => {
    const policy = createPolicy();
    policy.contribute({ PolicyDocument: { Statement: [] } });
    const send = vi.spyOn(iamClient, "send");

    await expect(policy.create(await policy.getParams())).rejects.toThrow(
      "Role policy app-role-policy has no statements",
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe("LambdaRolePolicy drift detection", () => {
  async function planUnchanged(document: unknown) {
    vi.spyOn(iamClient, "send").mockImplementation(async (command) => {
      if (command instanceof sdk.GetRolePolicyCommand) {
        return {
          RoleName: "app-role",
          PolicyName: "app-role-policy",
          PolicyDocument: encodeURIComponent(JSON.stringify(document)),
        };
      }
      throw new Error("unexpected command");
    });
    const role = new LambdaIamRole("app-role", {
      config: { RoleName: "app-role" },
    });
    const policy = createPolicy(role);
    policy.contribute({ PolicyDocument: { Statement: [orders] } });
    const params = await policy.getParams();
    const plan = await createPlan({
      resources: [role, policy],
      state: new MemoryStateBackend({
        "app-role-policy": {
          version: 1,
          id: "app-role-policy",
          type: LambdaRolePolicy.type,
          config: policy.config,
          params,
          output: params,
          lastOperation: "create",
          lastOperationAt: "2026-10-30T00:00:00.000Z",
        },
      }),
    });
    return plan.nodes.find((node) => node.id === "app-role-policy");
  }

  it("does not report an unchanged document as drifted", async () => {
    const node = await planUnchanged({
      Version: "2012-10-17",
      Statement: [orders],
    });
    expect(node).toMatchObject({ decision: "noop" });
  });

  it("reports a changed document as drift to update", async () => {
    const node = await planUnchanged({
      Version: "2012-10-17",
      Statement: [refunds],
    });
    expect(node).toMatchObject({ decision: "drift-update" });
  });
});
