import * as iam from "@aws-sdk/client-iam";
import * as lambda from "@aws-sdk/client-lambda";
import { expect, it } from "vitest";
import {
  attachedPolicyArns,
  clients,
  describeE2e,
  functionsWithPrefix,
  inlinePolicyNames,
  logGroupsWithPrefix,
  roleExists,
  roleNameOf,
  rolesWithPrefix,
  useProject,
} from "../e2e";

const basicExecutionPolicy =
  "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";

// The trust policy that the provider sets, with a Sid added. The trust policy
// is immutable in the role's schema, so drift in it replaces the role.
const driftedTrustPolicy = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "Drifted",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

describeE2e("LambdaIamRole", () => {
  const project = useProject();
  let functionName: string;
  let oldRole: string;

  async function functionRole(): Promise<string> {
    const config = await clients.lambda.send(
      new lambda.GetFunctionConfigurationCommand({
        FunctionName: functionName,
      }),
    );
    return roleNameOf(config.Role!);
  }

  async function expectRoleWithPolicies(role: string) {
    expect(await inlinePolicyNames(role)).toEqual(["fn-role-policy"]);
    expect(await attachedPolicyArns(role)).toEqual([basicExecutionPolicy]);
  }

  it("creates a function with a role that has an inline and a managed policy", async () => {
    project.write(
      "runtime/fn.ts",
      `
      import { $lambda, type LambdaHandler } from "@notation/aws/lambda";

      export const lambda = $lambda({
        id: "fn",
        policy: () => [
          { Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
        ],
      });

      export const handler: LambdaHandler<typeof lambda> = async () => "ok";
      `,
    );
    project.write("infra/main.ts", `import "../runtime/fn";`);
    await project.notation("deploy");

    const functions = await functionsWithPrefix(project.scope);
    expect(functions).toHaveLength(1);
    functionName = functions[0]!;
    oldRole = await functionRole();
    expect(await rolesWithPrefix(project.scope)).toEqual([oldRole]);
    await expectRoleWithPolicies(oldRole);
  });

  it("replaces the role when its trust policy drifts, moves the function and the policies to the new role, and deletes the old role", async () => {
    await clients.iam.send(
      new iam.UpdateAssumeRolePolicyCommand({
        RoleName: oldRole,
        PolicyDocument: driftedTrustPolicy,
      }),
    );
    await project.notation("deploy");

    const newRole = await functionRole();
    expect(newRole).not.toBe(oldRole);
    expect(await functionsWithPrefix(project.scope)).toEqual([functionName]);
    expect(await rolesWithPrefix(project.scope)).toEqual([newRole]);
    await expectRoleWithPolicies(newRole);
    expect(await roleExists(oldRole)).toBe(false);
  });

  it("destroys the function, its role and its log group", async () => {
    await project.notation("destroy");

    expect(await functionsWithPrefix(project.scope)).toEqual([]);
    expect(await rolesWithPrefix(project.scope)).toEqual([]);
    expect(await logGroupsWithPrefix(`/aws/lambda/${project.scope}`)).toEqual(
      [],
    );
  });
});
