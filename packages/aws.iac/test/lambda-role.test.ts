import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-iam";
import { createPlan } from "@notation/reconciler";
import type { DurableObject } from "@notation/resource";
import { MemoryStateBackend } from "@notation/state";
import { iamClient } from "src/utils/aws-clients";
import { LambdaIamRole } from "src/resources/lambda/lambda-role";
import { lambdaTrustPolicy } from "src/templates/iam.policy";

const boundaryArn = "arn:aws:iam::123456789012:policy/boundary";

// GetRole returns the trust policy URL-encoded (RFC 3986), the boundary as an
// object, and fields the role was never configured with.
function getRoleResponse(
  overrides: Partial<sdk.Role> = {},
): sdk.GetRoleResponse {
  return {
    Role: {
      Path: "/",
      RoleName: "app-role",
      RoleId: "AROAEXAMPLEID",
      Arn: "arn:aws:iam::123456789012:role/app-role",
      CreateDate: new Date("2026-07-22T00:00:00.000Z"),
      AssumeRolePolicyDocument: encodeURIComponent(
        JSON.stringify(lambdaTrustPolicy),
      ),
      MaxSessionDuration: 3600,
      PermissionsBoundary: {
        PermissionsBoundaryType: "PermissionsBoundaryPolicy",
        PermissionsBoundaryArn: boundaryArn,
      },
      RoleLastUsed: {},
      ...overrides,
    },
  };
}

function mockGetRole(response: sdk.GetRoleResponse) {
  vi.spyOn(iamClient, "send").mockImplementation(async (command: unknown) => {
    if (command instanceof sdk.GetRoleCommand) return response;
    throw new Error(
      `unexpected command ${(command as object).constructor.name}`,
    );
  });
}

// Plans a role whose state matches its config, as after a successful create.
async function planUnchangedRole(config: DurableObject) {
  const role = new LambdaIamRole("role", { config: config as any });
  const params = await role.getParams();
  const plan = await createPlan({
    resources: [role],
    state: new MemoryStateBackend({
      role: {
        version: 1,
        id: "role",
        type: LambdaIamRole.type,
        config,
        params: JSON.parse(JSON.stringify(params)),
        output: JSON.parse(JSON.stringify(params)),
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    }),
  });
  return plan.nodes[0];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LambdaIamRole drift detection", () => {
  it("does not report an unchanged role as drifted", async () => {
    mockGetRole(getRoleResponse());
    const node = await planUnchangedRole({ RoleName: "app-role" });
    expect(node).toMatchObject({ decision: "noop" });
  });

  it("does not report an unchanged permissions boundary as drifted", async () => {
    mockGetRole(getRoleResponse());
    const node = await planUnchangedRole({
      RoleName: "app-role",
      PermissionsBoundary: boundaryArn,
    });
    expect(node).toMatchObject({ decision: "noop" });
  });

  it("still detects a changed trust policy", async () => {
    const changed = {
      ...lambdaTrustPolicy,
      Statement: [
        {
          ...lambdaTrustPolicy.Statement[0],
          Principal: { Service: "edgelambda.amazonaws.com" },
        },
      ],
    };
    mockGetRole(
      getRoleResponse({
        AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(changed)),
      }),
    );
    const node = await planUnchangedRole({ RoleName: "app-role" });
    expect(node).toMatchObject({
      decision: "drift-replace",
      replaceFields: [{ name: "AssumeRolePolicyDocument", known: true }],
    });
  });

  it("still detects a changed permissions boundary", async () => {
    mockGetRole(
      getRoleResponse({
        PermissionsBoundary: {
          PermissionsBoundaryType: "PermissionsBoundaryPolicy",
          PermissionsBoundaryArn: "arn:aws:iam::123456789012:policy/other",
        },
      }),
    );
    const node = await planUnchangedRole({
      RoleName: "app-role",
      PermissionsBoundary: boundaryArn,
    });
    expect(node).toMatchObject({
      decision: "drift-replace",
      replaceFields: [{ name: "PermissionsBoundary", known: true }],
    });
  });
});

describe("LambdaIamRole result", () => {
  it("returns the declared fields", async () => {
    mockGetRole(
      getRoleResponse({
        RoleLastUsed: {
          LastUsedDate: new Date("2026-07-23T00:00:00.000Z"),
          Region: "eu-west-2",
        },
        Tags: [{ Key: "team", Value: "platform" }],
      }),
    );
    const role = new LambdaIamRole("role", {
      config: { RoleName: "app-role" },
    });

    const result = role.toResult(await role.read!({ RoleName: "app-role" }));

    expect(result).toMatchObject({
      CreateDate: new Date("2026-07-22T00:00:00.000Z"),
      RoleLastUsed: {
        LastUsedDate: new Date("2026-07-23T00:00:00.000Z"),
        Region: "eu-west-2",
      },
    });
    expect(result).not.toHaveProperty("Tags");
  });
});
