import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeModule, stripForInfra, stripForRuntime } from "src/index";
import { packageFiles, packages, root, virtualMarks } from "./virtual";

const handlerModule = `
import "./sentry";
import { createLambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { SQSClient } from "@aws-sdk/client-sqs";
import { ordersQueue, unused } from "../infra/orders";
import { Order, type OrderType } from "./schema";

type Local = OrderType;
const client = new SQSClient({});
const memory = 512;
const config = await fetch("https://example.com");

export const lambda = createLambda({
  id: "process-orders",
  memory,
  event: () => sqs(Order, { infra: ordersQueue.arn }),
  policy: () => [ordersQueue.grant(["ReceiveMessage"])],
  env: () => ({ QUEUE_URL: ordersQueue.url, LOG_LEVEL: "info" }),
});

export const handler: LambdaHandler<typeof lambda> = async (event: Local) => {
  await client.send(config);
};
`;

const files = {
  ...packageFiles,
  "runtime/handler.ts": handlerModule,
  "runtime/schema.ts": `export const Order = {};\nexport type OrderType = {};`,
  "runtime/sentry.ts": `console.log("init");`,
  "infra/orders.ts": `import { createQueue } from "@notation/aws/sqs";\nexport const ordersQueue = createQueue({ id: "orders" });\nexport const unused = 1;`,
};

const file = path.join(root, "runtime/handler.ts");

function setup(source = handlerModule) {
  const marks = virtualMarks(
    { ...files, "runtime/handler.ts": source },
    packages,
  );
  const analysis = analyzeModule(marks.table(file)!, marks);
  const isInfraModule = (f: string) =>
    analyzeModule(marks.table(f)!, marks).isInfra;
  return { marks, analysis, isInfraModule };
}

describe("stripForInfra", () => {
  it("keeps only the declaration and the statements that it uses", () => {
    const { code, declaration } = stripForInfra(setup().analysis);
    expect(declaration).toEqual({
      path: file,
      binding: "lambda",
      entry: "handler",
    });
    expect(code).toContain(
      `import { createLambda, sqs } from "@notation/aws/lambda";`,
    );
    expect(code).toContain(`import { ordersQueue } from "../infra/orders";`);
    expect(code).toContain(`import { Order } from "./schema";`);
    expect(code).toContain("const memory = 512;");
    expect(code).toContain("type Local = OrderType;");
    for (const removed of [
      "./sentry",
      "SQSClient",
      "await fetch",
      "export const handler",
      "unused",
    ]) {
      expect(code).not.toContain(removed);
    }
  });

  it("wraps the declaration in a call that records its module", () => {
    const { code } = stripForInfra(setup().analysis);
    expect(code).toMatch(
      /export const lambda = \$declaredIn\(createLambda\(\{[\s\S]*\}\), "file:\/\/\/project\/runtime\/handler\.ts", "lambda"\);/,
    );
    expect(code).toContain("function $declaredIn(value, url, binding)");
  });

  it("replaces runtime-only options with a function that throws", () => {
    const source = `
      /** @declaration runtime: class */
      function createNamespace(config) { return config; }
      const counters = createNamespace({ id: "counters", class: class Counter {} });
      export const handler = 1;
    `;
    const { code } = stripForInfra(setup(source).analysis);
    expect(code).toContain(
      `class: () => { throw new Error("class only runs in the function, not in the infra build."); }`,
    );
    expect(code).not.toContain("Counter");
  });

  it("fails when the module doesn't export the entry", () => {
    const source = handlerModule.replace(
      "export const handler",
      "const handler",
    );
    expect(() => stripForInfra(setup(source).analysis)).toThrow(
      "runtime/handler.ts: the module declares a function with createLambda, so it must export `handler`",
    );
  });
});

describe("stripForRuntime", () => {
  const runtimeSource = handlerModule.replace(
    ", { infra: ordersQueue.arn }",
    ", ordersQueue.arn",
  );

  it("reduces the declaration to its runtime options", () => {
    const { analysis, marks, isInfraModule } = setup(runtimeSource);
    const { code } = stripForRuntime(analysis, marks, isInfraModule)!;
    expect(code).toContain(
      `export const lambda = createLambda({
  event: () => sqs(Order, undefined),
  env: () => ({ QUEUE_URL: undefined, LOG_LEVEL: undefined }),
});`,
    );
    expect(code).toContain("export const handler");
  });

  it("removes the last option with the comma before it", () => {
    const source = `
      import { createLambda } from "@notation/aws/lambda";
      export const lambda = createLambda({ event: () => null, id: "a", memory: 1 });
      export const handler = 1;
    `;
    const { analysis, marks, isInfraModule } = setup(source);
    expect(stripForRuntime(analysis, marks, isInfraModule)!.code).toContain(
      "createLambda({ event: () => null });",
    );
  });

  it("fails when a kept option refers to an infra module", () => {
    const { analysis, marks, isInfraModule } = setup(
      runtimeSource.replace(
        "sqs(Order, ordersQueue.arn)",
        "sqs(ordersQueue.schema)",
      ),
    );
    expect(() => stripForRuntime(analysis, marks, isInfraModule)).toThrow(
      "runtime/handler.ts:16:20: an option of createLambda that the function keeps refers to ordersQueue, from the infra module ../infra/orders",
    );
  });

  it("fails for a keys option that isn't an object literal", () => {
    const source = runtimeSource.replace(
      `env: () => ({ QUEUE_URL: ordersQueue.url, LOG_LEVEL: "info" })`,
      `env: () => ({ ...base })`,
    );
    const { analysis, marks, isInfraModule } = setup(source);
    expect(() => stripForRuntime(analysis, marks, isInfraModule)).toThrow(
      "the env option of createLambda must be a function that returns an object literal",
    );
  });
});
