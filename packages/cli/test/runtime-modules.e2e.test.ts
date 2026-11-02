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
import { compileInfra, compileRuntimeModules } from "../src/compile";

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

it("deploys a runtime module as one lambda that dispatches to each export", async () => {
  write(
    "runtime/todos.fn.ts",
    `
    import { handle, json, type LambdaResource } from "@notation/aws/lambda.fn";

    export const getTodos = handle.apiRequest(() => json("get"));
    export const createTodo = handle.apiRequest(() => json("create"));
    export const cleanUp = handle.eventBridgeScheduledEvent((event) => {
      return "clean " + event.source;
    });

    export const resource: LambdaResource = {
      service: "aws/lambda",
      id: "todos",
      timeout: 5,
      memory: 64,
    };
    `,
  );
  write(
    "infra/main.ts",
    `
    import { api, router } from "@notation/aws/api-gateway";
    import { schedule, rate } from "@notation/aws/event-bridge";
    import { getTodos, createTodo, cleanUp } from "../runtime/todos.fn";

    const todoRouter = router(api({ name: "todo-api" }));
    todoRouter.get("/todos", getTodos);
    todoRouter.post("/todos", createTodo);
    schedule({ name: "clean-up", schedule: rate(1, "hour"), handler: cleanUp });
    `,
  );

  await compileRuntimeModules(
    await compileInfra(path.join(root, "infra/main.ts")),
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
    const [fn, ...otherFns] = ofType("aws/lambda/LambdaFunction");
    ofType("aws/apiGateway/Api")[0].setOutput({ ApiId: "api-1" });
    fn.dependencies.role.setOutput({ Arn: "arn:role" });
    fn.dependencies.zipFile.setOutput({ filePath: "todos.zip", fileSha256: "sha" });
    const params = await fn.getParams();
    const [rule] = ofType("aws/eventBridge/rule");
    const template = rule.config.Targets[0].InputTransformer.InputTemplate;

    process.env.NOTATION_RUNTIME = encodeRuntime(params.Environment.Runtime);
    const { handler } = await import("./dist/runtime/todos.fn/index.mjs");
    const request = (routeKey) => ({ routeKey, requestContext: { apiId: "api-1" } });
    const scheduled = JSON.parse(
      template.replace("<aws.events.event.json>", JSON.stringify({ source: "aws.events" })),
    );

    console.log(JSON.stringify({
      lambdas: 1 + otherFns.length,
      handler: params.Handler,
      timeout: params.Timeout,
      memory: params.MemorySize,
      zipSource: fn.dependencies.zipFile.config.sourceFilePath,
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

  expect(JSON.parse(output)).toEqual({
    lambdas: 1,
    handler: "index.handler",
    timeout: 5,
    memory: 64,
    zipSource: "dist/runtime/todos.fn/index.mjs",
    get: { statusCode: 200, body: '"get"' },
    post: { statusCode: 200, body: '"create"' },
    scheduled: "clean aws.events",
  });
});
