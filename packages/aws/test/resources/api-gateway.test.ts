import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-apigatewayv2";
import {
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  validateValues,
  ValueValidationError,
} from "@notation/resource";
import { createPlan } from "@notation/reconciler";
import { MemoryStateBackend } from "@notation/state";
import { apiGatewayClient } from "src/resources/utils/aws-clients";
import { Api } from "src/resources/api-gateway/api";
import { Route } from "src/resources/api-gateway/route";
import {
  CREATE_TOKEN_TAG,
  createTokenTagValue,
} from "src/resources/utils/create-token";
import { awsCallMayHaveTakenEffect } from "src/resources/utils/errors";

vi.mock("src/resources/context", () => ({
  getAwsAccountId: async () => "123456789012",
}));

const TOKEN = "notation:create:execution-1:api:0";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockSend(handler: (command: unknown) => unknown) {
  return vi
    .spyOn(apiGatewayClient(), "send")
    .mockImplementation(async (command) => handler(command) as any);
}

describe("API Gateway API", () => {
  const api = new Api("api", {
    config: { Name: "app", ProtocolType: "HTTP" },
  });

  it("reports a create that gets a server error as unknown", async () => {
    const serverError = { $metadata: { httpStatusCode: 503 } };
    mockSend(() => {
      throw serverError;
    });

    const created = api.create(
      { Name: "app", ProtocolType: "HTTP" } as any,
      undefined,
      TOKEN,
    );

    await expect(created).rejects.toSatisfy(ResourceCreationUnknownError.is);
    await expect(created).rejects.toMatchObject({ cause: serverError });
  });

  it("rethrows a create that gets a client error", async () => {
    const clientError = { $metadata: { httpStatusCode: 400 } };
    mockSend(() => {
      throw clientError;
    });

    await expect(
      api.create(
        { Name: "app", ProtocolType: "HTTP" } as any,
        undefined,
        TOKEN,
      ),
    ).rejects.toBe(clientError);
  });

  it("tags the API with the hash of the create token", async () => {
    const send = mockSend(() => ({ ApiId: "api-1" }));

    await api.create(
      { Name: "app", ProtocolType: "HTTP", Tags: { team: "web" } } as any,
      undefined,
      TOKEN,
    );

    const command = send.mock.calls[0]![0] as sdk.CreateApiCommand;
    expect(command.input.Tags).toEqual({
      team: "web",
      [CREATE_TOKEN_TAG]: createTokenTagValue(TOKEN),
    });
  });

  it("finds the API with the create token on a later page", async () => {
    mockSend((command) => {
      const { NextToken } = (command as sdk.GetApisCommand).input;
      if (!NextToken) {
        return { Items: [{ ApiId: "other", Tags: {} }], NextToken: "page-2" };
      }
      return {
        Items: [
          {
            ApiId: "api-1",
            Tags: { [CREATE_TOKEN_TAG]: createTokenTagValue(TOKEN) },
          },
        ],
      };
    });

    await expect(api.find!({} as any, TOKEN)).resolves.toEqual({
      ApiId: "api-1",
    });
  });

  it("reports no API when none has the create token", async () => {
    mockSend(() => ({ Items: [{ ApiId: "other", Tags: {} }] }));

    await expect(api.find!({} as any, TOKEN)).rejects.toSatisfy(
      ResourceNotFoundError.is,
    );
  });

  it("reads the tags without the create token", async () => {
    mockSend(() => ({
      ApiId: "api-1",
      Tags: { team: "web", [CREATE_TOKEN_TAG]: "hash" },
    }));
    const tagged = (await api.read!({ ApiId: "api-1" })) as { Tags: unknown };
    expect(tagged.Tags).toEqual({ team: "web" });

    vi.restoreAllMocks();
    mockSend(() => ({ ApiId: "api-1", Tags: { [CREATE_TOKEN_TAG]: "hash" } }));
    const untagged = (await api.read!({ ApiId: "api-1" })) as { Tags: unknown };
    expect(untagged.Tags).toBeUndefined();
  });

  it("reads an API in the shape its validators accept", async () => {
    mockSend(() => ({
      ApiId: "api-1",
      ApiEndpoint: "https://api-1.execute-api.eu-west-2.amazonaws.com",
      CreatedDate: new Date("2026-07-22T00:00:00.000Z"),
      Name: "app",
      ProtocolType: "HTTP",
      CorsConfiguration: { AllowOrigins: ["*"], MaxAge: 300 },
      Tags: { team: "web", [CREATE_TOKEN_TAG]: "hash" },
      $metadata: {},
    }));
    const result = await api.read!({ ApiId: "api-1" });

    expect(() =>
      validateValues(api, api.toResult(result), "read"),
    ).not.toThrow();
    expect(result.ExecuteApiSourceArn).toBe(
      "arn:aws:execute-api:us-west-2:123456789012:api-1/*/*",
    );
  });

  it("rejects a protocol type that API Gateway does not have", () => {
    expect(
      () =>
        new Api("bad-api", {
          config: { Name: "app", ProtocolType: "GRPC" } as any,
        }),
    ).toThrow(ValueValidationError);
  });
});

describe("API Gateway API drift", () => {
  it.each([
    ["no Tags", {}],
    ["empty Tags", { Tags: {} }],
  ])("reports no drift for an API with %s", async (_name, tags) => {
    const config = { Name: "app", ProtocolType: "HTTP" as const, ...tags };
    const api = new Api("api", { config });
    const params = await api.getParams();
    mockSend(() => ({
      ApiId: "api-1",
      Name: "app",
      ProtocolType: "HTTP",
      Tags: { [CREATE_TOKEN_TAG]: createTokenTagValue(TOKEN) },
    }));

    const plan = await createPlan({
      resources: [api],
      state: new MemoryStateBackend({
        api: {
          version: 1,
          id: "api",
          type: Api.type,
          provider: "test",
          config,
          params,
          output: { ...params, ApiId: "api-1" },
          lastOperation: "create",
          lastOperationAt: "2026-07-22T00:00:00.000Z",
        },
      }),
    });

    expect(plan.nodes[0]).toMatchObject({ decision: "noop" });
  });
});

describe("API Gateway route", () => {
  const route = new Route("route", {
    config: { RouteKey: "GET /todos" } as any,
    dependencies: {} as any,
  });

  it("finds the route with the route key", async () => {
    const send = mockSend(() => ({
      Items: [
        { RouteId: "r-1", RouteKey: "POST /todos" },
        { RouteId: "r-2", RouteKey: "GET /todos" },
      ],
    }));

    await expect(
      route.find!({ ApiId: "api-1", RouteKey: "GET /todos" }, TOKEN),
    ).resolves.toEqual({ RouteId: "r-2" });
    expect((send.mock.calls[0]![0] as sdk.GetRoutesCommand).input).toEqual({
      ApiId: "api-1",
      NextToken: undefined,
    });
  });

  it("reports no route when none has the route key", async () => {
    mockSend(() => ({ Items: [{ RouteId: "r-1", RouteKey: "POST /todos" }] }));

    await expect(
      route.find!({ ApiId: "api-1", RouteKey: "GET /todos" }, TOKEN),
    ).rejects.toSatisfy(ResourceNotFoundError.is);
  });

  it("reports no route when the API does not exist", async () => {
    const notFound = new sdk.NotFoundException({
      message: "Invalid API identifier specified",
      $metadata: {},
    });
    mockSend(() => {
      throw notFound;
    });

    const found = route.find!(
      { ApiId: "api-1", RouteKey: "GET /todos" },
      TOKEN,
    );

    await expect(found).rejects.toSatisfy(ResourceNotFoundError.is);
    await expect(found).rejects.toMatchObject({ cause: notFound });
  });
});

describe("awsCallMayHaveTakenEffect", () => {
  it.each([
    ["a server error", { $metadata: { httpStatusCode: 503 } }, true],
    [
      "a timeout",
      Object.assign(new Error("t"), { name: "TimeoutError" }),
      true,
    ],
    [
      "a reset connection",
      Object.assign(new Error("r"), { code: "ECONNRESET" }),
      true,
    ],
    ["a client error", { $metadata: { httpStatusCode: 400 } }, false],
    ["an error from Notation code", new Error("hash mismatch"), false],
    ["a value that is not an object", "boom", false],
  ])("classifies %s", (_name, error, expected) => {
    expect(awsCallMayHaveTakenEffect(error)).toBe(expected);
  });
});
