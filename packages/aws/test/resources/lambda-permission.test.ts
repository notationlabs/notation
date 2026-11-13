import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-lambda";
import {
  collectResourceGraph,
  ResourceAlreadyExistsError,
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  SchemaStructureError,
  validateParams,
} from "@notation/resource";
import { lambdaClient } from "src/resources/utils/aws-clients";
import { LambdaPermission } from "src/resources/lambda/lambda-permission";
import { Api } from "src/resources/api-gateway/api";
import { statementId } from "src/resources/utils/statement-id";

vi.mock("src/resources/context", () => ({
  getAwsAccountId: async () => "123456789012",
}));

const fn = {
  output: { FunctionName: "app--prod--orders" },
  schema: {},
} as any;
const key = { FunctionName: "app--prod--orders", StatementId: "events-daily" };

const permission = (config: Record<string, unknown> = {}) =>
  new LambdaPermission("eventbridge-permission:daily", {
    config: {
      Action: "lambda:InvokeFunction",
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
      StatementId: "eventbridge-permission_daily-b896f9ae98c7",
      Principal: "events.amazonaws.com",
      SourceArn: "arn:aws:events:us-west-2:123456789012:rule/daily",
    });
  });

  it("takes the Action from config", async () => {
    expect(
      (await permission({ Action: "lambda:InvokeFunctionUrl" }).getParams())
        .Action,
    ).toBe("lambda:InvokeFunctionUrl");
  });

  it("requires an Action", async () => {
    const resource = new LambdaPermission("p", {
      config: { Principal: "events.amazonaws.com" } as any,
      dependencies: { lambda: fn },
    });
    await expect(
      validateParams(resource, await resource.getParams(), "deploy"),
    ).rejects.toThrow(SchemaStructureError);
  });

  it("can be declared without a SourceArn", async () => {
    const params = await new LambdaPermission("p", {
      config: {
        Action: "lambda:InvokeFunction",
        Principal: "events.amazonaws.com",
      },
      dependencies: { lambda: fn },
    }).getParams();
    expect(params).not.toHaveProperty("SourceArn");
  });

  it("places the source's output ref as its SourceArn", async () => {
    let held!: InstanceType<typeof LambdaPermission>;
    let api!: InstanceType<typeof Api>;
    await collectResourceGraph(() => {
      api = new Api("api", { config: { ProtocolType: "HTTP" } });
      held = new LambdaPermission("p", {
        config: {
          Action: "lambda:InvokeFunction",
          Principal: "apigateway.amazonaws.com",
          SourceArn: api.outputRef("ExecuteApiSourceArn"),
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

  it("reports a statement that already exists as ResourceAlreadyExistsError", async () => {
    mockSend(() => {
      throw new sdk.ResourceConflictException({
        message:
          "The statement id (api-permission) provided already exists. Please provide a new statement id, or remove the existing statement.",
        $metadata: {},
      });
    });
    await expect(
      permission().create(await permission().getParams()),
    ).rejects.toSatisfy(ResourceAlreadyExistsError.is);
  });

  it("keeps a conflict that is not about an existing statement as it is", async () => {
    mockSend(() => {
      throw new sdk.ResourceConflictException({
        message: "The operation cannot be performed at this time.",
        $metadata: {},
      });
    });
    await expect(
      permission().create(await permission().getParams()),
    ).rejects.toBeInstanceOf(sdk.ResourceConflictException);
  });
});

describe("statementId", () => {
  it("keeps an ID that Lambda accepts", () => {
    expect(statementId("api-permission_todos")).toBe("api-permission_todos");
  });

  it("replaces characters that Lambda doesn't allow, and ends the ID with a hash", () => {
    expect(statementId("api-permission:todo-api:todos")).toBe(
      "api-permission_todo-api_todos-54afaaeaf3ac",
    );
  });

  it("gives different IDs to two IDs that differ only in a replaced character", () => {
    expect(statementId("p:a.b")).not.toBe(statementId("p:a_b"));
    expect(statementId("p:a_b")).not.toBe("p_a_b");
  });

  it("cuts an ID longer than 100 characters, and ends it with a hash", () => {
    const long = `api-permission:${"a".repeat(64)}:${"b".repeat(64)}`;
    const other = `api-permission:${"a".repeat(64)}:${"c".repeat(64)}`;

    expect(statementId(long)).toHaveLength(100);
    expect(statementId(long)).toMatch(/^[0-9A-Za-z_-]+$/);
    expect(statementId(long)).not.toBe(statementId(other));
  });
});
