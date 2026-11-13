import { afterEach, beforeEach, expect, expectTypeOf, test, vi } from "vitest";
import type { APIGatewayProxyEventV2, SQSEvent, SQSRecord } from "aws-lambda";
import { setConfigFile } from "@notation/core";
import {
  collectResourceGraph,
  type StandardSchemaV1,
} from "@notation/resource";
import * as infra from "src/lambda";
import {
  $lambda,
  apiGateway,
  DecodeError,
  sqs,
  type JwtClaims,
  type LambdaHandler,
  type SqsOptions,
} from "src/lambda";
import * as runtime from "src/lambda/runtime";
import { queue } from "src/sqs";
import { inModule, lambdaGroup, projectDir } from "./declare";

type Order = { id: string };

const Order: StandardSchemaV1<unknown, Order> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof (value as Order | undefined)?.id === "string"
        ? { value: value as Order }
        : { issues: [{ message: "id must be a string" }] },
  },
};

const orders = queue({ id: "orders", schema: Order });

const record = (body: string) => ({ body }) as SQSRecord;

beforeEach(() => setConfigFile(`${projectDir}/notation.config.ts`));
afterEach(() => {
  setConfigFile(undefined);
  vi.unstubAllEnvs();
});

test("the function deploys the runtime bundle of the declaration's module", async () => {
  const graph = await collectResourceGraph(() => {
    inModule($lambda({ id: "orders" }), "runtime/orders.ts");
  });
  const group = lambdaGroup(graph, "orders");

  expect(group.fn.dependencies.zipFile.config).toMatchObject({
    sourceFilePath: "dist/runtime/orders/index.mjs",
  });
  expect(group.fn.config.Handler).toBe("index.handler");
});

test("runtime, timeout, memory and concurrency are applied to the function", async () => {
  const graph = await collectResourceGraph(() => {
    inModule(
      $lambda({
        id: "orders",
        runtime: "nodejs20.x",
        timeout: 5,
        memory: 256,
        concurrency: 10,
      }),
    );
  });
  const group = lambdaGroup(graph, "orders");

  expect(group.fn.config).toMatchObject({
    Runtime: "nodejs20.x",
    Timeout: 5,
    MemorySize: 256,
  });
  expect(
    group.resources.find((r) => r.id === "lambda:orders:concurrency")?.config,
  ).toEqual({ ReservedConcurrentExecutions: 10 });
});

test("the id keys the function in state, and the function passes no name", async () => {
  const graph = await collectResourceGraph(() => {
    inModule($lambda({ id: "orders" }));
  });
  const group = lambdaGroup(graph, "orders");

  expect(group.fn.id).toBe("lambda:orders");
  expect(group.fn.config).not.toHaveProperty("FunctionName");
});

test("env is set as the function's environment variables", async () => {
  const graph = await collectResourceGraph(() => {
    inModule(
      $lambda({
        id: "orders",
        env: () => ({ TABLE: "orders", STAGE: "dev" }),
      }),
    );
  });
  const group = lambdaGroup(graph, "orders");
  group.role.setOutput({ Arn: "arn:role" } as any);
  group.fn.dependencies.zipFile.setOutput({
    filePath: "orders.zip",
    fileSha256: "sha",
  } as any);

  expect((await group.fn.getParams()).Environment).toEqual({
    Variables: { TABLE: "orders", STAGE: "dev" },
  });
});

test("a declaration without env sets no environment", async () => {
  const graph = await collectResourceGraph(() => {
    inModule($lambda({ id: "orders" }));
  });
  const group = lambdaGroup(graph, "orders");
  group.role.setOutput({ Arn: "arn:role" } as any);
  group.fn.dependencies.zipFile.setOutput({
    filePath: "orders.zip",
    fileSha256: "sha",
  } as any);

  expect((await group.fn.getParams()).Environment).toBeUndefined();
});

test("policy statements are added to the role's inline policy", async () => {
  const statement = {
    Effect: "Allow" as const,
    Action: ["dynamodb:GetItem"],
    Resource: "arn:aws:dynamodb:eu-west-2:123456789012:table/orders",
  };
  const graph = await collectResourceGraph(() => {
    inModule($lambda({ id: "orders", policy: () => [statement] }));
  });
  const group = lambdaGroup(graph, "orders");
  group.role.setOutput({ RoleName: "orders-role" } as any);

  expect((await group.policy.getParams()).PolicyDocument).toEqual({
    Version: "2012-10-17",
    Statement: [statement],
  });
});

test("a declaration that the infra build did not record throws when it is built", async () => {
  await expect(
    collectResourceGraph(() => {
      $lambda({ id: "orders" });
    }),
  ).rejects.toThrow(
    'The Lambda "orders" has no module. The infra build records the module of each $lambda call',
  );
});

test("an invalid id throws when the declaration is made", () => {
  expect(() => $lambda({ id: "bad.id" as any })).toThrow(
    'Invalid $lambda id "bad.id"',
  );
});

test("a duplicate id names $lambda in the error", async () => {
  await expect(
    collectResourceGraph(() => {
      inModule($lambda({ id: "orders" }));
      inModule($lambda({ id: "orders" }));
    }),
  ).rejects.toThrow('Duplicate $lambda id "orders"');
});

test("env() in infra returns the evaluated env", () => {
  const fn = $lambda({
    id: "orders",
    env: () => ({ TABLE: "orders" }),
  });

  expect(fn.env()).toEqual({ TABLE: "orders" });
});

test("decode() returns an SQS record with its body decoded", async () => {
  const fn = $lambda({ id: "orders", event: () => sqs.bind(orders) });
  const item = { messageId: "m1", body: '{"id":"1"}' } as SQSRecord;

  await expect(fn.decode(item)).resolves.toEqual({
    messageId: "m1",
    body: { id: "1" },
  });
});

test("decode() throws a DecodeError for a body that is not valid", async () => {
  const fn = $lambda({ id: "orders", event: () => sqs.bind(orders) });

  const error = await fn.decode(record('{"id":1}')).catch((e) => e);
  expect(error).toBeInstanceOf(DecodeError);
  expect(error.message).toBe(
    "The message body is not valid: id must be a string",
  );
  expect(error.part).toBe("body");
  expect(error.issues).toEqual([{ message: "id must be a string" }]);
});

test("decode() throws a DecodeError for a body that is not JSON", async () => {
  const fn = $lambda({ id: "orders", event: () => sqs.bind(orders) });

  const error = await fn.decode(record("not json")).catch((e) => e);
  expect(error).toBeInstanceOf(DecodeError);
  expect(error.message).toBe("The message body is not valid JSON.");
  expect(error.part).toBe("body");
});

test("decode() validates the body of an SQS record with the schema of sqs.schema()", async () => {
  const fn = $lambda({ id: "orders", event: () => sqs.schema(Order) });

  await expect(fn.decode(record('{"id":"1"}'))).resolves.toEqual({
    body: { id: "1" },
  });
  await expect(fn.decode(record("{}"))).rejects.toBeInstanceOf(DecodeError);
});

test("decode() for apiGateway reads a base64 body", async () => {
  const fn = $lambda({ id: "orders", event: () => apiGateway.schema(Order) });
  const body = Buffer.from('{"id":"1"}').toString("base64");

  await expect(fn.decode({ body, isBase64Encoded: true })).resolves.toEqual({
    body: { id: "1" },
    isBase64Encoded: true,
  });
});

test("the runtime variant reads env names from the option and values from process.env", () => {
  vi.stubEnv("TABLE", "orders-table");
  const fn = runtime.$lambda({
    id: "orders",
    // The runtime build keeps the names and removes the values.
    env: () => ({ TABLE: undefined as unknown as string }),
  });

  expect(fn.env()).toEqual({ TABLE: "orders-table" });
});

test("the runtime variant throws when a bound variable is not set", () => {
  vi.stubEnv("TABLE", undefined);
  const fn = runtime.$lambda({
    id: "orders",
    env: () => ({ TABLE: undefined as unknown as string }),
  });

  expect(() => fn.env()).toThrow("The environment variable TABLE is not set.");
});

test.each([
  ["sqs.bind()", () => runtime.sqs.bind(orders)],
  ["sqs.schema()", () => runtime.sqs.schema(Order)],
])("the runtime variant decodes %s as infra does", async (_, event) => {
  const fn = runtime.$lambda({ id: "orders", event });

  await expect(fn.decode(record('{"id":"1"}'))).resolves.toEqual({
    body: { id: "1" },
  });
  await expect(fn.decode(record("{}"))).rejects.toBeInstanceOf(DecodeError);
});

test("the runtime variant exports the same names as the infra module", () => {
  expect(Object.keys(runtime).sort()).toEqual(Object.keys(infra).sort());
});

test("the runtime variant's infra APIs throw", () => {
  expect(() => runtime.lambda()).toThrow(
    "lambda() declares infrastructure, so it can't run in a function.",
  );
});

test("a declaration types its handler, env() and decode()", () => {
  const sqsLambda = $lambda({
    id: "orders",
    event: () => sqs.bind(orders),
    env: () => ({ TABLE: "orders", STAGE: "dev" }),
  });

  expectTypeOf<
    Parameters<LambdaHandler<typeof sqsLambda>>[0]
  >().toEqualTypeOf<SQSEvent>();
  expectTypeOf(sqsLambda.env()).toEqualTypeOf<
    Readonly<{ TABLE: string; STAGE: string }>
  >();
  const decodeRecord = (item: SQSRecord) => sqsLambda.decode(item);
  type DecodedRecord = Awaited<ReturnType<typeof decodeRecord>>;
  expectTypeOf<DecodedRecord["body"]>().toEqualTypeOf<Order>();
  expectTypeOf<DecodedRecord["messageId"]>().toEqualTypeOf<string>();

  // @ts-expect-error the key is misspelt
  sqsLambda.env().TABEL;

  // @ts-expect-error env values are strings
  $lambda({ id: "numbers", env: () => ({ N: 1 }) });
});

test("an SQS handler can return batch item failures only when the mapping reports them", () => {
  const failures = { batchItemFailures: [{ itemIdentifier: "1" }] };

  const reporting = $lambda({
    id: "reporting",
    event: () => sqs.bind(orders, { reportBatchItemFailures: true }),
  });
  const reports: LambdaHandler<typeof reporting> = async () => failures;
  const reportsNone: LambdaHandler<typeof reporting> = async () => {};

  const plain = $lambda({ id: "plain", event: () => sqs.bind(orders) });
  // @ts-expect-error Lambda would ignore the failures and delete the messages
  const ignored: LambdaHandler<typeof plain> = async () => failures;
  const succeeds: LambdaHandler<typeof plain> = async () => {};

  const off = $lambda({
    id: "off",
    event: () => sqs.bind(orders, { reportBatchItemFailures: false }),
  });
  // @ts-expect-error Lambda would ignore the failures and delete the messages
  const ignoredOff: LambdaHandler<typeof off> = () => failures;

  const batched = $lambda({
    id: "batched",
    event: () => sqs.bind(orders, { batchSize: 5 }),
  });
  // @ts-expect-error Lambda would ignore the failures and delete the messages
  const ignoredBatched: LambdaHandler<typeof batched> = async () => failures;

  // The mapping of sqs.schema() is made in infra, so either result is allowed.
  const mapped = $lambda({ id: "mapped", event: () => sqs.schema(Order) });
  const mappedReports: LambdaHandler<typeof mapped> = async () => failures;
  const mappedNone: LambdaHandler<typeof mapped> = async () => {};

  void [reports, reportsNone, ignored, succeeds, ignoredOff, ignoredBatched];
  void [mappedReports, mappedNone];
});

test("sqs.bind() rejects unknown option names next to known ones", () => {
  // @ts-expect-error maxBatchingWindow was renamed to maximumBatchingWindow
  sqs.bind(orders, { batchSize: 5, maxBatchingWindow: 20 });
  // @ts-expect-error a typo of reportBatchItemFailures
  sqs.bind(orders, { batchSize: 5, reportBatchItemFailure: true });
});

test("a boolean or a wide SqsOptions lets the handler return either result", () => {
  const failures = { batchItemFailures: [{ itemIdentifier: "1" }] };
  const flag = Math.random() > 0.5;
  const options: SqsOptions = {};

  const flagged = $lambda({
    id: "flagged",
    event: () => sqs.bind(orders, { reportBatchItemFailures: flag }),
  });
  const wide = $lambda({ id: "wide", event: () => sqs.bind(orders, options) });
  const flaggedReports: LambdaHandler<typeof flagged> = async () => failures;
  const wideReports: LambdaHandler<typeof wide> = async () => failures;
  const empty = $lambda({ id: "empty", event: () => sqs.bind(orders, {}) });
  // @ts-expect-error Lambda would ignore the failures and delete the messages
  const ignoredEmpty: LambdaHandler<typeof empty> = async () => failures;

  void [flaggedReports, wideReports, ignoredEmpty];
});

type Claims = { sub: string };

const Claims: StandardSchemaV1<unknown, Claims> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof (value as Claims | undefined)?.sub === "string"
        ? { value: value as Claims }
        : { issues: [{ message: "sub must be a string" }] },
  },
};

const request = (body: string | undefined, claims?: unknown) => ({
  body,
  isBase64Encoded: false,
  requestContext: { authorizer: { jwt: { claims } } },
});

test("a declaration with claims types its handler's event as a request through a JWT authorizer", () => {
  const user = $lambda({
    id: "user",
    event: () => apiGateway.schema(Order).authSchema(Claims),
  });
  type Event = Parameters<LambdaHandler<typeof user>>[0];

  expectTypeOf<Event>().toExtend<APIGatewayProxyEventV2>();
  // decode() validates the claims, but the event holds them as API Gateway
  // sends them.
  expectTypeOf<
    Event["requestContext"]["authorizer"]["jwt"]["claims"]
  >().toEqualTypeOf<JwtClaims>();
  const decodeUser = (event: Event) => user.decode(event);
  type DecodedUser = Awaited<ReturnType<typeof decodeUser>>;
  expectTypeOf<DecodedUser["body"]>().toEqualTypeOf<Order>();
  expectTypeOf<DecodedUser["claims"]>().toEqualTypeOf<Claims>();
  expectTypeOf<DecodedUser["requestContext"]>().toEqualTypeOf<
    Event["requestContext"]
  >();

  const any = $lambda({
    id: "any",
    event: () => apiGateway.schema(null).authSchema(),
  });
  type AnyEvent = Parameters<LambdaHandler<typeof any>>[0];
  expectTypeOf<AnyEvent>().toEqualTypeOf<Event>();
  const decodeAny = (event: AnyEvent) => any.decode(event);
  type DecodedAny = Awaited<ReturnType<typeof decodeAny>>;
  expectTypeOf<DecodedAny["body"]>().toEqualTypeOf<undefined>();
  expectTypeOf<DecodedAny["claims"]>().toEqualTypeOf<JwtClaims>();

  const plain = $lambda({ id: "plain", event: () => apiGateway.schema(null) });
  type PlainEvent = Parameters<LambdaHandler<typeof plain>>[0];
  expectTypeOf<PlainEvent>().toEqualTypeOf<APIGatewayProxyEventV2>();
  const decodePlain = (event: PlainEvent) => plain.decode(event);
  type DecodedPlain = Awaited<ReturnType<typeof decodePlain>>;
  expectTypeOf<DecodedPlain["body"]>().toEqualTypeOf<undefined>();
  expectTypeOf<DecodedPlain>().not.toHaveProperty("claims");

  const orders = $lambda({ id: "orders", event: () => sqs.schema(Order) });
  const ordersHandler: LambdaHandler<typeof orders> = async () => {};
  // @ts-expect-error an SQS handler can't serve a JWT Lambda
  const wrong: LambdaHandler<typeof user> = ordersHandler;
  void wrong;

  // Only type-checked.
  const typeOnly = () =>
    // @ts-expect-error decode() of a declaration with claims needs the request's claims
    user.decode({ body: "{}", isBase64Encoded: false });
  const typeOnlyAny = () =>
    // @ts-expect-error decode() after authSchema() needs the request's claims
    any.decode({ body: "{}", isBase64Encoded: false });
  // @ts-expect-error apiGateway.schema() needs a schema, or null for no body
  const noBody = () => apiGateway.schema();
  void typeOnly;
  void typeOnlyAny;
  void noBody;
});

test("decode() returns a request with its body and its JWT claims decoded", async () => {
  const fn = $lambda({
    id: "user",
    event: () => apiGateway.schema(Order).authSchema(Claims),
  });

  await expect(
    fn.decode(request('{"id":"o1"}', { sub: "u1" })),
  ).resolves.toEqual({
    ...request('{"id":"o1"}', { sub: "u1" }),
    body: { id: "o1" },
    claims: { sub: "u1" },
  });
  const error = await fn
    .decode(request('{"id":"o1"}', { sub: 1 }))
    .catch((e) => e);
  expect(error).toBeInstanceOf(DecodeError);
  expect(error.message).toBe(
    "The request's JWT claims are not valid: sub must be a string",
  );
  expect(error.part).toBe("claims");
  expect(error.issues).toEqual([{ message: "sub must be a string" }]);
  expectTypeOf<DecodeError["part"]>().toEqualTypeOf<
    "body" | "claims" | "detail"
  >();
});

test("decode() throws a DecodeError for a request with no JWT claims, when the declaration has claims", async () => {
  const fn = $lambda({
    id: "user",
    event: () => apiGateway.schema(null).authSchema(Claims),
  });

  const error = await fn
    .decode({ body: "{}", isBase64Encoded: false } as any)
    .catch((e) => e);
  expect(error).toBeInstanceOf(DecodeError);
  expect(error.message).toBe(
    "The request has no JWT claims. Route it through a route with a JWT authorizer.",
  );
  expect(error.part).toBe("claims");
});

test("decode() of a request with no body and no body schema returns an undefined body", async () => {
  const fn = $lambda({
    id: "user",
    event: () => apiGateway.schema(null).authSchema(Claims),
  });

  await expect(
    fn.decode(request(undefined, { sub: "u1" })),
  ).resolves.toMatchObject({ body: undefined, claims: { sub: "u1" } });
  await expect(fn.decode(request(undefined, {}))).rejects.toThrow(
    "sub must be a string",
  );
});

test("decode() with a body schema of null returns an undefined body, and rejects a body", async () => {
  const fn = $lambda({ id: "ping", event: () => apiGateway.schema(null) });

  for (const body of [undefined, ""]) {
    await expect(fn.decode({ body, isBase64Encoded: false })).resolves.toEqual({
      body: undefined,
      isBase64Encoded: false,
    });
  }
  for (const request of [
    { body: "{}", isBase64Encoded: false },
    { body: Buffer.from("text").toString("base64"), isBase64Encoded: true },
  ]) {
    const error = await fn.decode(request).catch((e) => e);
    expect(error).toBeInstanceOf(DecodeError);
    expect(error.message).toBe(
      "The request has a body, but the function's body schema is null, so its requests must have no body.",
    );
    expect(error.part).toBe("body");
  }
});

test("decode() with a string schema accepts a JSON string body, and rejects plain text", async () => {
  const Text: StandardSchemaV1<unknown, string> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) =>
        typeof value === "string"
          ? { value }
          : { issues: [{ message: "expected a string" }] },
    },
  };
  const fn = $lambda({ id: "text", event: () => apiGateway.schema(Text) });

  await expect(
    fn.decode({ body: '"hello"', isBase64Encoded: false }),
  ).resolves.toEqual({ body: "hello", isBase64Encoded: false });
  await expect(
    fn.decode({
      body: Buffer.from('"hello"').toString("base64"),
      isBase64Encoded: true,
    }),
  ).resolves.toEqual({ body: "hello", isBase64Encoded: true });
  await expect(
    fn.decode({ body: "hello", isBase64Encoded: false }),
  ).rejects.toThrow("The request body is not valid JSON.");
  await expect(
    fn.decode({ body: "123", isBase64Encoded: false }),
  ).rejects.toThrow("The request body is not valid: expected a string");
});

test("decode() with an object schema throws for a body that is not JSON", async () => {
  const fn = $lambda({ id: "orders", event: () => apiGateway.schema(Order) });

  const error = await fn
    .decode({ body: "not json", isBase64Encoded: false })
    .catch((e) => e);
  expect(error).toBeInstanceOf(DecodeError);
  expect(error.message).toBe("The request body is not valid JSON.");
  expect(error.part).toBe("body");
  await expect(
    fn.decode({ body: '{"id":1}', isBase64Encoded: false }),
  ).rejects.toThrow("The request body is not valid: id must be a string");
});

test("decode() with a body schema validates an empty body as undefined", async () => {
  const Optional: StandardSchemaV1<unknown, Order | undefined> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) =>
        value === undefined
          ? { value: undefined }
          : Order["~standard"].validate(value),
    },
  };
  const optional = $lambda({
    id: "optional",
    event: () => apiGateway.schema(Optional),
  });
  const required = $lambda({
    id: "required",
    event: () => apiGateway.schema(Order),
  });

  for (const body of [undefined, ""]) {
    await expect(
      optional.decode({ body, isBase64Encoded: false }),
    ).resolves.toEqual({ body: undefined, isBase64Encoded: false });
    const error = await required
      .decode({ body, isBase64Encoded: false })
      .catch((e) => e);
    expect(error).toBeInstanceOf(DecodeError);
    expect(error.message).toBe(
      "The request body is not valid: id must be a string",
    );
  }
});

test("decode() of a request with no authorizer returns no claims", async () => {
  const fn = $lambda({ id: "orders", event: () => apiGateway.schema(Order) });

  await expect(
    fn.decode({ body: '{"id":"o1"}', isBase64Encoded: false }),
  ).resolves.toEqual({ body: { id: "o1" }, isBase64Encoded: false });
});

test("decode() after authSchema() with no claims schema returns the claims as the request holds them", async () => {
  const fn = $lambda({
    id: "user",
    event: () => apiGateway.schema(null).authSchema(),
  });

  await expect(
    fn.decode(request(undefined, { anything: 1 })),
  ).resolves.toMatchObject({ body: undefined, claims: { anything: 1 } });
  await expect(
    fn.decode({ body: undefined, isBase64Encoded: false } as any),
  ).rejects.toThrow(
    "The request has no JWT claims. Route it through a route with a JWT authorizer.",
  );
});

test("the runtime variant validates claims as infra does", async () => {
  const fn = runtime.$lambda({
    id: "user",
    event: () => runtime.apiGateway.schema(Order).authSchema(Claims),
  });

  await expect(
    fn.decode(request('{"id":"o1"}', { sub: "u1" })),
  ).resolves.toMatchObject({ body: { id: "o1" }, claims: { sub: "u1" } });
  await expect(
    fn.decode(request('{"id":"o1"}', { sub: 1 })),
  ).rejects.toBeInstanceOf(DecodeError);
});

test("decode() of a declaration with scheduled events throws", async () => {
  const fn = $lambda({
    id: "nightly",
    event: () => runtime.eventBridge.schema(null),
  });

  await expect((fn.decode as any)({})).rejects.toThrow(
    "decode() needs a Lambda declared with event: () => sqs.bind(queue), sqs.schema(schema), apiGateway.bind(api).defineRoute(options), apiGateway.schema(body), eventBridge.bind(bus).defineRule(options) or eventBridge.schema(schema). A scheduled event has no detail to decode.",
  );
});
