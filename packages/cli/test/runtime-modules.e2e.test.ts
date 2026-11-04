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
