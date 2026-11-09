import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

// A Standard Schema validator, so the project needs no validator library.
const schemaModule = `
  export const Order = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) =>
        typeof value?.id === "string"
          ? { value }
          : { issues: [{ message: "id must be a string" }] },
    },
  };
`;

it("deploys a declaration module as a lambda that reads its bound variables", async () => {
  write("shared/schema.ts", schemaModule);
  write(
    "runtime/process-orders.ts",
    `
    import { $lambda, DecodeError, sqs, type LambdaHandler } from "@notation/aws/lambda";
    import { ordersQueue } from "../infra/orders";

    export const lambda = $lambda({
      id: "process-orders",
      timeout: 5,
      event: () => sqs(ordersQueue, { batchSize: 5 }),
      policy: () => [ordersQueue.grant(["SendMessage"])],
      env: () => ({ QUEUE_URL: ordersQueue.url, LOG_LEVEL: "info" }),
    });

    export const handler: LambdaHandler<typeof lambda> = async (event) => {
      const orders = [];
      for (const record of event.Records) {
        try {
          orders.push(await lambda.decode(record));
        } catch (error) {
          if (!(error instanceof DecodeError)) throw error;
        }
      }
      console.log(JSON.stringify({ orders, env: lambda.env() }));
    };
    `,
  );
  write(
    "infra/orders.ts",
    `
    import { queue } from "@notation/aws/sqs";
    import { Order } from "../shared/schema";

    export const ordersQueue = queue({ name: "orders", schema: Order });
    `,
  );

  await compileRuntimeModules(
    (await compileInfra(path.join(root, "infra/orders.ts"))).modules,
  );

  // Evaluates the infra bundle, fills in the outputs that the lambda's params
  // need, and then calls the runtime bundle with the environment that a
  // deploy would give the lambda. A separate process gives the runtime bundle
  // a fresh environment and module cache.
  const script = `
    import { collectResourceGraph, resolveOutputValues, deployLookup } from "@notation/resource";

    const graph = await collectResourceGraph(() => import("./dist/infra/orders.mjs"));
    const ofType = (type) => graph.resources.filter((r) => r.type === type);
    const [fn, ...otherFns] = ofType("aws/lambda/LambdaFunction");
    const [queue] = ofType("aws/sqs/Queue");
    queue.setOutput({ QueueUrl: "https://sqs/orders", QueueArn: "arn:orders", QueueName: "orders" });
    fn.dependencies.role.setOutput({ Arn: "arn:role" });
    fn.dependencies.zipFile.setOutput({ filePath: "fn.zip", fileSha256: "sha" });
    const params = await fn.getParams();
    const [policy] = ofType("aws/lambda/LambdaRolePolicy");
    const statements = (await policy.getParams()).PolicyDocument.Statement;
    const mappings = ofType("aws/lambda/LambdaEventSourceMapping");

    Object.assign(process.env, params.Environment.Variables);
    const { handler } = await import("./dist/runtime/process-orders/index.mjs");
    const record = (messageId, body) => ({ messageId, body: JSON.stringify(body) });
    await handler({ Records: [record("1", { id: "o1" }), record("2", { id: 2 })] }, {});

    console.log(JSON.stringify({
      lambdas: 1 + otherFns.length,
      handler: params.Handler,
      timeout: params.Timeout,
      variables: params.Environment.Variables,
      actions: statements.flatMap((s) => s.Action),
      mappings: mappings.map((m) => m.id),
      zipSource: fn.dependencies.zipFile.config.sourceFilePath,
    }));
  `;
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: root, encoding: "utf8" },
  );
  const [logged, summary] = output.trim().split("\n");

  expect(JSON.parse(summary!)).toEqual({
    lambdas: 1,
    handler: "index.handler",
    timeout: 5,
    variables: { QUEUE_URL: "https://sqs/orders", LOG_LEVEL: "info" },
    actions: [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:SendMessage",
    ],
    mappings: ["orders-process-orders-mapping"],
    zipSource: "dist/runtime/process-orders/index.mjs",
  });
  expect(JSON.parse(logged!)).toEqual({
    orders: [{ id: "o1" }],
    env: { QUEUE_URL: "https://sqs/orders", LOG_LEVEL: "info" },
  });

  const bundle = readFileSync(
    path.join(root, "dist/runtime/process-orders/index.mjs"),
    "utf8",
  );
  expect(bundle).not.toMatch(/@aws-sdk|aws\.iac|LambdaGroup|ordersQueue/);
});
