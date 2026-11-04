import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setConfigFile } from "@notation/core";
import { compile } from "../src/compile";
import type { Logger } from "../src/logger";

// Inside this package, so the project's imports of @notation/aws resolve
// from the package's node_modules, to the built package.
const tmpDir = fileURLToPath(new URL("../tmp", import.meta.url));

let root: string;

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
  root = realpathSync(mkdtempSync(path.join(tmpDir, "notation-e2e-")));
  writeFileSync(path.join(root, "notation.config.ts"), "export default {}");
  setConfigFile(path.join(root, "notation.config.ts"));
});

afterEach(() => {
  setConfigFile(undefined);
  rmSync(root, { recursive: true, force: true });
});

const write = (file: string, contents: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), contents);
};

const logger = { info: () => {}, error: () => {} } as unknown as Logger;

it("declares each function with lambda() and bundles it with a dispatcher to its handlers", async () => {
  write(
    "runtime/todos.fn.ts",
    `
    import { json } from "@notation/aws/lambda.fn";
    import { lambda } from "@notation/aws/lambda" with { type: "infra" };
    import { todoQueue, settings } from "../infra/queues" with { type: "infra" };

    console.log("todos init");
    const { handle } = lambda({
      id: settings.id,
      timeout: 5,
      memory: settings.memory * 2,
      grants: [todoQueue.grant(["SendMessage"])],
    });

    export const getTodos = handle.apiRequest(() => json("get"));
    export const createTodo = handle.apiRequest(() => json("create"));
    export const cleanUp = handle.eventBridgeScheduledEvent((event) => {
      return "clean " + event.source;
    });
    export const drain = handle.sqsEvent(() => {});
    `,
  );
  write(
    "runtime/reports.fn.ts",
    `
    import { lambda } from "@notation/aws/lambda" with { type: "infra" };
    const { handle } = lambda({ id: "reports" });
    export const report = handle.apiRequest(() => ({ statusCode: 200, body: "report" }));
    `,
  );
  write(
    "infra/main.ts",
    `
    import { api, router } from "@notation/aws/api-gateway";
    import { schedule, rate } from "@notation/aws/event-bridge";
    import * as todos from "../runtime/todos.fn" with { type: "runtime" };
    import { report } from "../runtime/reports.fn" with { type: "runtime" };

    const todoRouter = router(api({ name: "todo-api" }));
    todoRouter.get("/todos", todos.getTodos);
    todoRouter.post("/todos", todos.createTodo);
    todoRouter.get("/report", report);
    schedule({ name: "clean-up", schedule: rate(1, "hour"), handler: todos.cleanUp });

    // Declared after the routes, and read by the todos function's settings.
    export { settings } from "./queues";
    `,
  );
  write(
    "infra/queues.ts",
    `
    import { queue } from "@notation/aws/sqs";
    import { drain } from "../runtime/todos.fn" with { type: "runtime" };
    export const todoQueue = queue({ name: "todos" });
    todoQueue.consume(drain);
    export const settings = { id: "todos", memory: 64 };
    `,
  );

  await compile(
    {
      entryPoint: path.join(root, "infra/main.ts"),
      runtimeModules: ["**/*.fn.ts"],
    },
    { logger },
  );

  // Evaluates the infra bundle, fills in the outputs that the lambda's params
  // need, and then calls the runtime bundle with the environment that a
  // deploy would give the lambda. A separate process gives the runtime bundle
  // a fresh environment and module cache.
  const script = `
    import { collectResourceGraph } from "@notation/resource";
    import { encodeRuntime } from "@notation/aws.iac/shared";

    const graph = await collectResourceGraph(() => import("./dist/infra/main.mjs"));
    const ofType = (type) => graph.resources.filter((r) => r.type === type);
    const fns = ofType("aws/lambda/LambdaFunction");
    const fn = fns.find((f) => f.id === "todos");
    ofType("aws/apiGateway/Api")[0].setOutput({ ApiId: "api-1" });
    ofType("aws/sqs/Queue")[0].setOutput({ QueueArn: "arn:queue", QueueUrl: "https://queue" });
    fn.dependencies.role.setOutput({ Arn: "arn:role", RoleName: "todos-role" });
    fn.dependencies.zipFile.setOutput({ filePath: "todos.zip", fileSha256: "sha" });
    const params = await fn.getParams();
    const policy = graph.resources.find((r) => r.id === "todos-role-policy");
    const [rule] = ofType("aws/eventBridge/rule");
    const template = rule.config.Targets[0].InputTransformer.InputTemplate;

    process.env.NOTATION_RUNTIME = encodeRuntime(params.Environment.Runtime);
    const { handler } = await import("./dist/functions/todos/index.mjs");
    const request = (routeKey) => ({ routeKey, requestContext: { apiId: "api-1" } });
    const scheduled = JSON.parse(
      template.replace("<aws.events.event.json>", JSON.stringify({ source: "aws.events" })),
    );

    console.log(JSON.stringify({
      lambdas: fns.map((f) => f.id).sort(),
      functions: graph.runtimeFunctions.map((f) => [f.id, f.handlers.map((h) => h.export)]),
      handler: params.Handler,
      timeout: params.Timeout,
      memory: params.MemorySize,
      zipSource: fn.dependencies.zipFile.config.sourceFilePath,
      actions: (await policy.getParams()).PolicyDocument.Statement.map((s) => s.Action),
      get: await handler(request("GET /todos"), {}),
      post: await handler(request("POST /todos"), {}),
      scheduled: await handler(scheduled, {}),
    }));
  `;
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: root, encoding: "utf8" },
  );

  const lines = output.trim().split("\n");
  // The runtime module's code runs in the function, never in the infra phase.
  expect(lines.slice(0, -1)).toEqual(["todos init"]);
  expect(JSON.parse(lines.at(-1)!)).toEqual({
    lambdas: ["reports", "todos"],
    functions: [
      ["reports", ["report"]],
      ["todos", ["cleanUp", "createTodo", "drain", "getTodos"]],
    ],
    handler: "index.handler",
    timeout: 5,
    memory: 128,
    zipSource: "dist/functions/todos/index.mjs",
    actions: [
      ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      ["sqs:SendMessage"],
    ],
    get: { statusCode: 200, body: '"get"' },
    post: { statusCode: 200, body: '"create"' },
    scheduled: "clean aws.events",
  });
});

it("fails at compile when a handler isn't exported", async () => {
  write(
    "runtime/todos.fn.ts",
    `
    import { lambda } from "@notation/aws/lambda" with { type: "infra" };
    const { handle } = lambda({ id: "todos" });
    export const getTodos = handle.apiRequest(() => ({}));
    const hidden = handle.apiRequest(() => ({}));
    `,
  );
  write(
    "infra/main.ts",
    `
    import { getTodos } from "../runtime/todos.fn" with { type: "runtime" };
    import { api, router } from "@notation/aws/api-gateway";
    router(api({ name: "todo-api" })).get("/todos", getTodos);
    `,
  );

  await expect(
    compile(
      {
        entryPoint: path.join(root, "infra/main.ts"),
        runtimeModules: ["**/*.fn.ts"],
      },
      { logger },
    ),
  ).rejects.toThrow(
    /The api handler made at .*runtime\/todos\.fn\.ts:5 isn't exported from a runtime module/,
  );
});

it("delivers the values that a function's bundle reads from infra", async () => {
  write(
    "runtime/checkout.fn.ts",
    `
    import { lambda } from "@notation/aws/lambda" with { type: "infra" };
    import { orderQueue, settings } from "../infra/orders" with { type: "infra" };

    const grants = [orderQueue.grant(["SendMessage"])];
    const { handle } = lambda({ id: "checkout", grants });

    const unused = () => orderQueue.arn;

    export const createOrder = handle.apiRequest(async () => ({
      statusCode: 200,
      body: JSON.stringify({ url: orderQueue.url, settings }),
    }));
    `,
  );
  write(
    "infra/orders.ts",
    `
    import { api, router } from "@notation/aws/api-gateway";
    import { queue } from "@notation/aws/sqs";
    import { createOrder } from "../runtime/checkout.fn" with { type: "runtime" };

    export const orderQueue = queue({ name: "orders" });
    export const settings = { memory: 64, region: "eu-west-2" };
    router(api({ name: "orders-api" })).post("/orders", createOrder);
    `,
  );

  await compile(
    {
      entryPoint: path.join(root, "infra/orders.ts"),
      runtimeModules: ["**/*.fn.ts"],
    },
    { logger },
  );

  // Collects the graph as plan does, fills in the outputs that the lambda's
  // params need, and calls the bundle with the environment that a deploy
  // would give it.
  const script = `
    import { readFileSync } from "node:fs";
    import { getResourceGraph, setConfigFile } from "@notation/core";
    import { encodeRuntime } from "@notation/aws.iac/shared";

    setConfigFile(process.cwd() + "/notation.config.ts");
    const graph = await getResourceGraph(process.cwd() + "/infra/orders.ts", undefined, { runtimeReads: true });
    const ofType = (type) => graph.resources.filter((r) => r.type === type);
    const [fn] = ofType("aws/lambda/LambdaFunction");
    ofType("aws/apiGateway/Api")[0].setOutput({ ApiId: "api-1" });
    ofType("aws/sqs/Queue")[0].setOutput({ QueueArn: "arn:queue", QueueUrl: "https://sqs.test/orders" });
    fn.dependencies.role.setOutput({ Arn: "arn:role", RoleName: "checkout-role" });
    fn.dependencies.zipFile.setOutput({ filePath: "checkout.zip", fileSha256: "sha" });
    const params = await fn.getParams();
    const policy = graph.resources.find((r) => r.id === "checkout-role-policy");

    process.env.NOTATION_RUNTIME = encodeRuntime(params.Environment.Runtime);
    const { handler } = await import("./dist/functions/checkout/index.mjs");
    const response = await handler({ routeKey: "POST /orders", requestContext: { apiId: "api-1" } }, {});

    console.log(JSON.stringify({
      reads: JSON.parse(readFileSync("dist/functions/checkout/reads.json", "utf8")),
      outputs: params.Environment.Runtime.outputs,
      actions: (await policy.getParams()).PolicyDocument.Statement.map((s) => s.Action),
      body: JSON.parse(response.body),
    }));
  `;
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: root, encoding: "utf8" },
  );

  const settings = { memory: 64, region: "eu-west-2" };
  expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({
    // The read in `unused` is tree-shaken, so it isn't delivered.
    reads: {
      reads: ["infra/orders#orderQueue.url", "infra/orders#settings"],
    },
    outputs: {
      "infra/orders#orderQueue.url": "https://sqs.test/orders",
      "infra/orders#settings": settings,
    },
    actions: [["sqs:SendMessage"]],
    body: { url: "https://sqs.test/orders", settings },
  });
});

it("fails at compile when a handler calls infra", async () => {
  write(
    "runtime/checkout.fn.ts",
    `
    import { lambda } from "@notation/aws/lambda" with { type: "infra" };
    import { orderQueue } from "../infra/orders" with { type: "infra" };
    const { handle } = lambda({ id: "checkout" });
    export const createOrder = handle.apiRequest(async () => {
      orderQueue.grant(["SendMessage"]);
      return { statusCode: 200 };
    });
    `,
  );
  write(
    "infra/orders.ts",
    `
    import { api, router } from "@notation/aws/api-gateway";
    import { queue } from "@notation/aws/sqs";
    import { createOrder } from "../runtime/checkout.fn" with { type: "runtime" };
    export const orderQueue = queue({ name: "orders" });
    router(api({ name: "orders-api" })).post("/orders", createOrder);
    `,
  );

  await expect(
    compile(
      {
        entryPoint: path.join(root, "infra/orders.ts"),
        runtimeModules: ["**/*.fn.ts"],
      },
      { logger },
    ),
  ).rejects.toThrow(/orderQueue\.grant\(\) calls infra from runtime code/);
});

it("fails at plan when a function stores an infra method", async () => {
  write(
    "runtime/checkout.fn.ts",
    `
    import { lambda } from "@notation/aws/lambda" with { type: "infra" };
    import { orderQueue } from "../infra/orders" with { type: "infra" };
    const { handle } = lambda({ id: "checkout" });
    export const createOrder = handle.apiRequest(async () => {
      const grant = orderQueue.grant;
      return { statusCode: 200, body: String(grant) };
    });
    `,
  );
  write(
    "infra/orders.ts",
    `
    import { api, router } from "@notation/aws/api-gateway";
    import { queue } from "@notation/aws/sqs";
    import { createOrder } from "../runtime/checkout.fn" with { type: "runtime" };
    export const orderQueue = queue({ name: "orders" });
    router(api({ name: "orders-api" })).post("/orders", createOrder);
    `,
  );

  await compile(
    {
      entryPoint: path.join(root, "infra/orders.ts"),
      runtimeModules: ["**/*.fn.ts"],
    },
    { logger },
  );

  const script = `
    import { getResourceGraph, setConfigFile } from "@notation/core";
    setConfigFile(process.cwd() + "/notation.config.ts");
    await getResourceGraph(process.cwd() + "/infra/orders.ts", undefined, { runtimeReads: true });
  `;
  expect(() =>
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    }),
  ).toThrow(
    /The function "checkout" reads infra\/orders#orderQueue\.grant, which is a function of infra/,
  );
});
