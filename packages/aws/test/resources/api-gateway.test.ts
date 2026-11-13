import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@aws-sdk/client-apigatewayv2";
import {
  ResourceAlreadyExistsError,
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  validateValues,
  ValueValidationError,
} from "@notation/resource";
import { createPlan } from "@notation/reconciler";
import { MemoryStateBackend } from "@notation/state";
import { apiGatewayClient } from "src/resources/utils/aws-clients";
import { Api } from "src/resources/api-gateway/api";
import { RouteAuth } from "src/resources/api-gateway/auth";
import { LambdaIntegration } from "src/resources/api-gateway/lambda-integration";
import { Route } from "src/resources/api-gateway/route";
import { Stage } from "src/resources/api-gateway/stage";
import { awsCallMayHaveTakenEffect } from "src/resources/utils/errors";

vi.mock("src/resources/context", () => ({
  getAwsAccountId: async () => "123456789012",
}));

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

    const created = api.create({ Name: "app", ProtocolType: "HTTP" } as any);

    await expect(created).rejects.toSatisfy(ResourceCreationUnknownError.is);
    await expect(created).rejects.toMatchObject({ cause: serverError });
  });

  it("rethrows a create that gets a client error", async () => {
    const clientError = { $metadata: { httpStatusCode: 400 } };
    mockSend(() => {
      throw clientError;
    });

    await expect(
      api.create({ Name: "app", ProtocolType: "HTTP" } as any),
    ).rejects.toBe(clientError);
  });

  it("finds the API with the name on a later page", async () => {
    mockSend((command) => {
      const { NextToken } = (command as sdk.GetApisCommand).input;
      if (!NextToken) {
        return {
          Items: [{ ApiId: "other", Name: "other" }],
          NextToken: "page-2",
        };
      }
      return { Items: [{ ApiId: "api-1", Name: "app" }] };
    });

    await expect(api.find!({ Name: "app" } as any)).resolves.toEqual({
      ApiId: "api-1",
    });
  });

  it("reports no API when none has the name", async () => {
    mockSend(() => ({ Items: [{ ApiId: "other", Name: "other" }] }));

    await expect(api.find!({ Name: "app" } as any)).rejects.toSatisfy(
      ResourceNotFoundError.is,
    );
  });

  it("fails to find the API when several have the name, and names them", async () => {
    mockSend((command) => {
      const { NextToken } = (command as sdk.GetApisCommand).input;
      if (!NextToken) {
        return { Items: [{ ApiId: "api-1", Name: "app" }], NextToken: "p2" };
      }
      return { Items: [{ ApiId: "api-2", Name: "app" }] };
    });

    const found = api.find!({ Name: "app" } as any);

    await expect(found).rejects.toThrow(
      "Found 2 resources for API Gateway API named app, so cannot tell " +
        "which one to use: api-1, api-2. Delete all but one.",
    );
    await expect(found).rejects.not.toSatisfy(ResourceNotFoundError.is);
  });

  it("reads an API in the shape its validators accept", async () => {
    mockSend(() => ({
      ApiId: "api-1",
      ApiEndpoint: "https://api-1.execute-api.eu-west-2.amazonaws.com",
      CreatedDate: new Date("2026-07-22T00:00:00.000Z"),
      Name: "app",
      ProtocolType: "HTTP",
      CorsConfiguration: { AllowOrigins: ["*"], MaxAge: 300 },
      Tags: { team: "web", "notation:create-token": "hash" },
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

describe("API Gateway API with the create token tag of an earlier version", () => {
  const api = new Api("api", {
    config: { Name: "app", ProtocolType: "HTTP" },
  });

  it("reads the tags without the tag", async () => {
    mockSend(() => ({
      ApiId: "api-1",
      Tags: { team: "web", "notation:create-token": "hash" },
    }));
    const tagged = (await api.read!({ ApiId: "api-1" })) as { Tags: unknown };
    expect(tagged.Tags).toEqual({ team: "web" });

    vi.restoreAllMocks();
    mockSend(() => ({
      ApiId: "api-1",
      Tags: { "notation:create-token": "hash" },
    }));
    const untagged = (await api.read!({ ApiId: "api-1" })) as { Tags: unknown };
    expect(untagged.Tags).toBeUndefined();
  });
});

describe("API Gateway authorizer", () => {
  const auth = new RouteAuth("auth", {
    config: { Name: "jwt" } as any,
    dependencies: {} as any,
  });
  const params = { ApiId: "api-1", Name: "jwt" } as any;

  it("reports a create that gets a server error as unknown", async () => {
    mockSend(() => {
      throw { $metadata: { httpStatusCode: 503 } };
    });

    await expect(auth.create(params)).rejects.toSatisfy(
      ResourceCreationUnknownError.is,
    );
  });

  it("finds the authorizer with the name in the API", async () => {
    const send = mockSend(() => ({
      Items: [
        { AuthorizerId: "a-1", Name: "other" },
        { AuthorizerId: "a-2", Name: "jwt" },
      ],
    }));

    await expect(auth.find!(params)).resolves.toEqual({ AuthorizerId: "a-2" });
    expect((send.mock.calls[0]![0] as sdk.GetAuthorizersCommand).input).toEqual(
      { ApiId: "api-1", NextToken: undefined },
    );
  });

  it("reports no authorizer when none has the name", async () => {
    mockSend(() => ({ Items: [{ AuthorizerId: "a-1", Name: "other" }] }));

    await expect(auth.find!(params)).rejects.toSatisfy(
      ResourceNotFoundError.is,
    );
  });

  it("reports no authorizer when the API does not exist", async () => {
    mockSend(() => {
      throw new sdk.NotFoundException({
        message: "Invalid API identifier specified",
        $metadata: {},
      });
    });

    await expect(auth.find!(params)).rejects.toSatisfy(
      ResourceNotFoundError.is,
    );
  });

  it("fails to find the authorizer when several have the name, and names them", async () => {
    mockSend(() => ({
      Items: [
        { AuthorizerId: "a-1", Name: "jwt" },
        { AuthorizerId: "a-2", Name: "jwt" },
      ],
    }));

    const found = auth.find!(params);

    await expect(found).rejects.toThrow("a-1, a-2");
    await expect(found).rejects.not.toSatisfy(ResourceNotFoundError.is);
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
      Tags: { "notation:create-token": "hash" },
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

  it("reports a route key that the API already has as already existing", async () => {
    const conflict = new sdk.ConflictException({
      message: "Route with key GET /todos already exists for this API",
      $metadata: {},
    });
    mockSend(() => {
      throw conflict;
    });

    const created = route.create({
      ApiId: "api-1",
      RouteKey: "GET /todos",
    } as any);

    await expect(created).rejects.toSatisfy(ResourceAlreadyExistsError.is);
    await expect(created).rejects.toMatchObject({ cause: conflict });
  });

  it("finds the route with the route key", async () => {
    const send = mockSend(() => ({
      Items: [
        { RouteId: "r-1", RouteKey: "POST /todos" },
        { RouteId: "r-2", RouteKey: "GET /todos" },
      ],
    }));

    await expect(
      route.find!({ ApiId: "api-1", RouteKey: "GET /todos" }),
    ).resolves.toEqual({ RouteId: "r-2" });
    expect((send.mock.calls[0]![0] as sdk.GetRoutesCommand).input).toEqual({
      ApiId: "api-1",
      NextToken: undefined,
    });
  });

  it("reports no route when none has the route key", async () => {
    mockSend(() => ({ Items: [{ RouteId: "r-1", RouteKey: "POST /todos" }] }));

    await expect(
      route.find!({ ApiId: "api-1", RouteKey: "GET /todos" }),
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

    const found = route.find!({ ApiId: "api-1", RouteKey: "GET /todos" });

    await expect(found).rejects.toSatisfy(ResourceNotFoundError.is);
    await expect(found).rejects.toMatchObject({ cause: notFound });
  });
});

describe("API Gateway stage", () => {
  it("reports a stage name that the API already has as already existing", async () => {
    const conflict = new sdk.ConflictException({
      message: "Stage already exists",
      $metadata: {},
    });
    mockSend(() => {
      throw conflict;
    });
    const stage = new Stage("stage", {
      config: { StageName: "$default" } as any,
      dependencies: {} as any,
    });

    const created = stage.create({
      ApiId: "api-1",
      StageName: "$default",
    } as any);

    await expect(created).rejects.toSatisfy(ResourceAlreadyExistsError.is);
    await expect(created).rejects.toMatchObject({ cause: conflict });
  });
});

describe("API Gateway Lambda integration", () => {
  it("reports a create that gets a server error as unknown", async () => {
    mockSend(() => {
      throw { $metadata: { httpStatusCode: 503 } };
    });
    const integration = new LambdaIntegration("integration", {
      config: {} as any,
      dependencies: {} as any,
    });

    await expect(
      integration.create({ ApiId: "api-1" } as any),
    ).rejects.toSatisfy(ResourceCreationUnknownError.is);
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
