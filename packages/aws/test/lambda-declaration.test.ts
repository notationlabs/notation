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

test("runtime, timeout and memory are applied to the function", async () => {
  const graph = await collectResourceGraph(() => {
    inModule(
      $lambda({
        id: "orders",
        runtime: "nodejs20.x",
        timeout: 5,
        memory: 256,
      }),
    );
  });

  expect(lambdaGroup(graph, "orders").fn.config).toMatchObject({
    Runtime: "nodejs20.x",
    Timeout: 5,
    MemorySize: 256,
  });
});

test("name overrides the function's AWS name, and the id stays its state key", async () => {
  const graph = await collectResourceGraph(() => {
    inModule($lambda({ id: "orders", name: "order-handler" }));
  });
  const group = lambdaGroup(graph, "orders");

  expect(group.fn.id).toBe("orders");
  expect(group.fn.config.FunctionName).toBe("order-handler");
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

test("an invalid name and a duplicate id name $lambda in the error", async () => {
  await expect(
    collectResourceGraph(() => {
      inModule($lambda({ id: "orders", name: "bad.name" }));
    }),
  ).rejects.toThrow('Invalid $lambda name "bad.name"');
  await expect(
    collectResourceGraph(() => {
      inModule($lambda({ id: "orders" }));
      inModule($lambda({ id: "orders" }));
    }),
  ).rejects.toThrow('Duplicate $lambda id "orders"');
});

test("a $lambda whose AWS name is another Lambda's throws, with both modules", async () => {
  await expect(
    collectResourceGraph(() => {
      inModule($lambda({ id: "a", name: "b" }), "runtime/a.ts");
      inModule($lambda({ id: "b" }), "runtime/b.ts");
    }),
  ).rejects.toThrow(
    '$lambda({ id: "a", name: "b" }) in runtime/a.ts and $lambda({ id: "b" }) in runtime/b.ts both give a Lambda function the AWS name "b".',
  );
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
  expect(error.issues).toEqual([{ message: "id must be a string" }]);
});

test("decode() throws a DecodeError for a body that is not JSON", async () => {
  const fn = $lambda({ id: "orders", event: () => sqs.bind(orders) });

  const error = await fn.decode(record("not json")).catch((e) => e);
  expect(error).toBeInstanceOf(DecodeError);
  expect(error.message).toBe("The message body is not valid JSON.");
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
    event: () => apiGateway.schema().authSchema(),
  });
  type AnyEvent = Parameters<LambdaHandler<typeof any>>[0];
  expectTypeOf<AnyEvent>().toEqualTypeOf<Event>();
  const decodeAny = (event: AnyEvent) => any.decode(event);
  type DecodedAny = Awaited<ReturnType<typeof decodeAny>>;
  expectTypeOf<DecodedAny["body"]>().toEqualTypeOf<unknown>();
  expectTypeOf<DecodedAny["claims"]>().toEqualTypeOf<JwtClaims>();

  const plain = $lambda({ id: "plain", event: () => apiGateway.schema() });
  type PlainEvent = Parameters<LambdaHandler<typeof plain>>[0];
  expectTypeOf<PlainEvent>().toEqualTypeOf<APIGatewayProxyEventV2>();
  const decodePlain = (event: PlainEvent) => plain.decode(event);
  type DecodedPlain = Awaited<ReturnType<typeof decodePlain>>;
  expectTypeOf<DecodedPlain["body"]>().toEqualTypeOf<unknown>();
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
  void typeOnly;
  void typeOnlyAny;
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
  expect(error.issues).toEqual([{ message: "sub must be a string" }]);
});

test("decode() throws a DecodeError for a request with no JWT claims, when the declaration has claims", async () => {
  const fn = $lambda({
    id: "user",
    event: () => apiGateway.schema().authSchema(Claims),
  });

  await expect(
    fn.decode({ body: "{}", isBase64Encoded: false } as any),
  ).rejects.toThrow(
    "The request has no JWT claims. Route it through a route with a JWT authorizer.",
  );
});

test("decode() of a request with no body and no body schema returns an undefined body", async () => {
  const fn = $lambda({
    id: "user",
    event: () => apiGateway.schema().authSchema(Claims),
  });

  await expect(
    fn.decode(request(undefined, { sub: "u1" })),
  ).resolves.toMatchObject({ body: undefined, claims: { sub: "u1" } });
  await expect(fn.decode(request(undefined, {}))).rejects.toThrow(
    "sub must be a string",
  );
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
    event: () => apiGateway.schema().authSchema(),
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

test("authSchema() is not part of the event's data", () => {
  const event = apiGateway.schema(Order);

  expect(Object.keys(event)).toEqual(["kind", "schema", "claims"]);
  expect(event.authSchema(Claims)).toEqual({
    kind: "apiGateway-jwt",
    schema: Order,
    claims: Claims,
  });
  expect(event.authSchema()).toEqual({
    kind: "apiGateway-jwt",
    schema: Order,
    claims: undefined,
  });
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

test("decode() of a declaration with an eventBridge event throws", async () => {
  const fn = $lambda({
    id: "nightly",
    event: () => runtime.eventBridge.schedule(),
  });

  await expect((fn.decode as any)({})).rejects.toThrow(
    "decode() needs a Lambda declared with event: () => sqs.bind(queue), sqs.schema(schema), apiGateway.bind(api).defineRoute(options) or apiGateway.schema(body).",
  );
});
