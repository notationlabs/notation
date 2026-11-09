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
  DecodeError,
  http,
  jwt,
  sqs,
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

const orders = queue({ name: "orders", schema: Order });

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
    'Invalid lambda id "bad.id"',
  );
});

test("env() in infra returns the evaluated env", () => {
  const fn = $lambda({
    id: "orders",
    env: () => ({ TABLE: "orders" }),
  });

  expect(fn.env()).toEqual({ TABLE: "orders" });
});

test("decode() validates the body of an SQS record", async () => {
  const fn = $lambda({ id: "orders", event: () => sqs.bind(orders) });

  await expect(fn.decode(record('{"id":"1"}'))).resolves.toEqual({ id: "1" });
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

  await expect(fn.decode(record('{"id":"1"}'))).resolves.toEqual({ id: "1" });
  await expect(fn.decode(record("{}"))).rejects.toBeInstanceOf(DecodeError);
});

test("decode() for http reads a base64 body", async () => {
  const fn = $lambda({ id: "orders", event: () => http({ body: Order }) });
  const body = Buffer.from('{"id":"1"}').toString("base64");

  await expect(fn.decode({ body, isBase64Encoded: true })).resolves.toEqual({
    id: "1",
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

  await expect(fn.decode(record('{"id":"1"}'))).resolves.toEqual({ id: "1" });
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
  expectTypeOf(sqsLambda.decode).returns.resolves.toEqualTypeOf<Order>();

  // @ts-expect-error the key is misspelt
  sqsLambda.env().TABEL;

  // @ts-expect-error env values are strings
  $lambda({ id: "numbers", env: () => ({ N: 1 }) });
});

test("a JWT declaration types the claims in its handler's event", () => {
  type Claims = { sub: string };
  const user = $lambda({
    id: "user",
    event: () => http({ body: Order, auth: jwt<Claims>() }),
  });
  type Event = Parameters<LambdaHandler<typeof user>>[0];

  expectTypeOf<Event>().toExtend<APIGatewayProxyEventV2>();
  expectTypeOf<
    Event["requestContext"]["authorizer"]["jwt"]["claims"]
  >().toEqualTypeOf<Claims>();
  expectTypeOf(user.decode).returns.resolves.toEqualTypeOf<Order>();

  const plain = $lambda({ id: "plain", event: () => http() });
  expectTypeOf<
    Parameters<LambdaHandler<typeof plain>>[0]
  >().toEqualTypeOf<APIGatewayProxyEventV2>();

  const orders = $lambda({ id: "orders", event: () => sqs.schema(Order) });
  const ordersHandler: LambdaHandler<typeof orders> = async () => {};
  // @ts-expect-error an SQS handler can't serve a JWT Lambda
  const wrong: LambdaHandler<typeof user> = ordersHandler;
  void wrong;
});

test("decode() reads the body of a request to a JWT declaration", async () => {
  const fn = $lambda({
    id: "user",
    event: () => http({ body: Order, auth: jwt() }),
  });
  await expect(
    fn.decode({ body: '{"id":"o1"}', isBase64Encoded: false }),
  ).resolves.toEqual({
    id: "o1",
  });
});
