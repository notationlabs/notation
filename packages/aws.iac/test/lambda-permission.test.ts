import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-lambda";
import {
  collectResourceGraph,
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  ValueValidationError,
} from "@notation/resource";
import { createPlan } from "@notation/reconciler";
import { MemoryStateBackend } from "@notation/state";
import { apiGatewayClient, lambdaClient } from "src/utils/aws-clients";
import { LambdaPermission } from "src/resources/lambda/lambda-permission";
import { Api } from "src/resources/api-gateway/api";
import { statementId } from "src/utils/statement-id";

vi.mock("src/context", () => ({
  getAwsAccountId: async () => "123456789012",
}));

const fn = { output: { FunctionName: "app--prod--orders" } } as any;
const key = { FunctionName: "app--prod--orders", StatementId: "events-daily" };

const permission = (config: Record<string, unknown> = {}) =>
  new LambdaPermission("p", {
    config: {
      StatementId: "events-daily",
      Principal: "events.amazonaws.com",
      SourceArn: "arn:aws:events:us-west-2:123456789012:rule/daily",
      ...config,
    },
    dependencies: { lambda: fn },
  });

function mockSend(respond: (command: unknown) => unknown) {
  return vi
    .spyOn(lambdaClient(), "send")
    .mockImplementation(async (command) => respond(command));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LambdaPermission", () => {
  it("takes the function name from the lambda and lets the service invoke it", async () => {
    expect(await permission().getParams()).toEqual({
      FunctionName: "app--prod--orders",
      Action: "lambda:InvokeFunction",
      StatementId: "events-daily",
      Principal: "events.amazonaws.com",
      SourceArn: "arn:aws:events:us-west-2:123456789012:rule/daily",
    });
  });

  it("rejects a StatementId with characters that Lambda doesn't allow", () => {
    expect(() => permission({ StatementId: "events:daily" })).toThrow(
      ValueValidationError,
    );
  });

  it("places the source's output value as its SourceArn", async () => {
    let held!: InstanceType<typeof LambdaPermission>;
    let api!: InstanceType<typeof Api>;
    await collectResourceGraph(() => {
      api = new Api("api", { config: { Name: "app", ProtocolType: "HTTP" } });
      held = new LambdaPermission("p", {
        config: {
          StatementId: "api-permission_api_orders",
          Principal: "apigateway.amazonaws.com",
          SourceArn: api.outputValue("ExecuteApiSourceArn"),
        },
        dependencies: { lambda: fn },
      });
    });
    expect(held.getDependencies()).toContain(api);

    api.setOutput({
      ExecuteApiSourceArn: "arn:aws:execute-api:us-west-2:1:abc/*/*",
    } as any);
    expect((await held.getParams()).SourceArn).toBe(
      "arn:aws:execute-api:us-west-2:1:abc/*/*",
    );
  });

  it("reads its statement from the function's policy", async () => {
    mockSend(() => ({
      Policy: JSON.stringify({
        Statement: [
          { Sid: "other", Action: "lambda:InvokeFunction" },
          {
            Sid: "events-daily",
            Effect: "Allow",
            Principal: { Service: "events.amazonaws.com" },
            Action: "lambda:InvokeFunction",
            Resource: "arn:aws:lambda:us-west-2:123456789012:function:orders",
            Condition: {
              ArnLike: {
                "AWS:SourceArn":
                  "arn:aws:events:us-west-2:123456789012:rule/daily",
              },
            },
          },
        ],
      }),
    }));

    expect(await permission().read!(key)).toMatchObject({
      Action: "lambda:InvokeFunction",
      Principal: "events.amazonaws.com",
      SourceArn: "arn:aws:events:us-west-2:123456789012:rule/daily",
    });
  });

  it("reads a statement that is not in the policy as not found", async () => {
    mockSend(() => ({ Policy: JSON.stringify({ Statement: [] }) }));
    await expect(permission().read!(key)).rejects.toSatisfy(
      ResourceNotFoundError.is,
    );
  });

  it("reads a function with no policy as not found", async () => {
    mockSend(() => {
      throw new sdk.ResourceNotFoundException({
        message: "The resource you requested does not exist.",
        $metadata: {},
      });
    });
    await expect(permission().read!(key)).rejects.toSatisfy(
      ResourceNotFoundError.is,
    );
  });

  it("deletes a statement that is already gone", async () => {
    mockSend(() => {
      throw new sdk.ResourceNotFoundException({ message: "", $metadata: {} });
    });
    await expect(permission().delete(key, {} as any)).resolves.toBeUndefined();
  });

  it("reports a create that gets a server error as unknown", async () => {
    mockSend(() => {
      throw { $metadata: { httpStatusCode: 503 } };
    });
    await expect(
      permission().create(await permission().getParams()),
    ).rejects.toSatisfy(ResourceCreationUnknownError.is);
  });
});

describe("statementId", () => {
  it("replaces characters that Lambda doesn't allow", () => {
    expect(statementId("api-permission:todo-api:todos")).toBe(
      "api-permission_todo-api_todos",
    );
  });

  it("cuts an ID longer than 100 characters, and ends it with a hash", () => {
    const long = `api-permission:${"a".repeat(64)}:${"b".repeat(64)}`;
    const other = `api-permission:${"a".repeat(64)}:${"c".repeat(64)}`;

    expect(statementId(long)).toHaveLength(100);
    expect(statementId(long)).toMatch(/^[0-9A-Za-z_-]+$/);
    expect(statementId(long)).not.toBe(statementId(other));
  });
});

// An API deployed before ExecuteApiSourceArn existed has a state record
// without it. Plan reads outputs from state, finds the field missing, and
// treats the SourceArn as known and undefined. Deploy checks params the same
// way before it changes anything, so it fails before it can read the API
// again to fill in the output.
it("a permission on an API whose state lacks ExecuteApiSourceArn fails to plan", async () => {
  const params = { Name: "app", ProtocolType: "HTTP" } as const;
  let resources!: [
    InstanceType<typeof Api>,
    InstanceType<typeof LambdaPermission>,
  ];
  await collectResourceGraph(() => {
    const api = new Api("api", { config: params });
    resources = [
      api,
      new LambdaPermission("p", {
        config: {
          StatementId: "api-permission_api_orders",
          Principal: "apigateway.amazonaws.com",
          SourceArn: api.outputValue("ExecuteApiSourceArn"),
        },
        dependencies: { lambda: fn },
      }),
    ];
  });

  vi.spyOn(apiGatewayClient(), "send").mockImplementation(async () => ({
    ...params,
    ApiId: "abc",
    ApiEndpoint: "https://abc",
    CreatedDate: new Date(0),
  }));
  const plan = createPlan({
    resources,
    state: new MemoryStateBackend({
      api: {
        version: 1,
        id: "api",
        type: Api.type,
        config: params,
        params,
        output: { ...params, ApiId: "abc", ApiEndpoint: "https://abc" },
        lastOperation: "create",
        lastOperationAt: "2026-07-22T00:00:00.000Z",
      },
    }),
  });
  await expect(plan).rejects.toThrow(
    "these required params are missing: SourceArn",
  );
});
