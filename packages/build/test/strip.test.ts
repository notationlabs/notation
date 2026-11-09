import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeModule,
  ModuleAnalyses,
  stripForInfra,
  stripForRuntime,
} from "src/index";
import { packageFiles, packages, root, virtualMarks } from "./virtual";

const handlerModule = `
import "./sentry";
import { $lambda, sqs, type LambdaHandler } from "@notation/aws/lambda";
import { SQSClient } from "@aws-sdk/client-sqs";
import { ordersQueue, unused } from "../infra/orders";
import { Order, type OrderType } from "./schema";

type Local = OrderType;
const client = new SQSClient({});
const memory = 512;
const config = await fetch("https://example.com");

export const lambda = $lambda({
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
  const analyses = new ModuleAnalyses({ marks, root });
  return { analysis, analyses };
}

function infra(source?: string, extra: Record<string, string> = {}) {
  const marks = virtualMarks(
    { ...files, "runtime/handler.ts": source ?? handlerModule, ...extra },
    packages,
  );
  return stripForInfra(analyzeModule(marks.table(file)!, marks), marks, root);
}

describe("stripForInfra", () => {
  it("keeps only the declaration and the statements that it uses", () => {
    const { code, declaration } = infra();
    expect(declaration).toEqual({
      path: file,
      binding: "lambda",
      entry: "handler",
    });
    expect(code).toContain(
      `import { $lambda, sqs } from "@notation/aws/lambda";`,
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
    const { code } = infra();
    expect(code).toMatch(
      /export const lambda = __notation_declaredIn\(\$lambda\(\{[\s\S]*\}\), "runtime\/handler\.ts", "lambda"\);/,
    );
    expect(code).toContain(
      "function __notation_declaredIn(value, path, binding)",
    );
  });

  it("keeps a satisfies after the call that records the module", () => {
    const source = handlerModule.replace(
      /\n\}\);\n\nexport const handler/,
      "\n}) satisfies object;\n\nexport const handler",
    );
    expect(infra(source).code).toMatch(
      /"runtime\/handler\.ts", "lambda"\) satisfies object;/,
    );
  });

  it.each([
    ["a const in a block", "if (x) { const Order = 1; } return sqs(Order);"],
    ["a function in a block", "{ function Order() {} } return sqs(Order);"],
    ["a const in a for head", "for (const Order of []) {} return sqs(Order);"],
    ["a catch parameter", "try {} catch (Order) {} return sqs(Order);"],
    [
      "a case of a switch",
      "switch (x) { case 1: { let Order; } } return sqs(Order);",
    ],
  ])("keeps an import that %s doesn't shadow outside it", (_, body) => {
    const source = handlerModule.replace(
      "event: () => sqs(Order, { infra: ordersQueue.arn })",
      `event: () => { ${body} }`,
    );
    expect(infra(source).code).toContain(`import { Order } from "./schema";`);
  });

  it("drops an import that a var in a block shadows in its function", () => {
    const source = handlerModule.replace(
      "event: () => sqs(Order, { infra: ordersQueue.arn })",
      "event: () => { if (x) { var Order = 1; } return sqs(Order); }",
    );
    expect(infra(source).code).not.toContain("./schema");
  });

  it("replaces runtime-only options with a function that throws", () => {
    const source = `
      /** @declaration runtime: class */
      function createNamespace(config) { return config; }
      const counters = createNamespace({ id: "counters", class: class Counter {} });
      export const handler = 1;
    `;
    const { code } = infra(source);
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
    expect(() => infra(source)).toThrow(
      "runtime/handler.ts: the module declares a function with $lambda, so it must export `handler`",
    );
  });

  it("accepts an entry that the module exports through export *", () => {
    const source = handlerModule.replace(
      /export const handler[\s\S]*$/,
      `export * from "./entry";\n`,
    );
    const extra = { "runtime/entry.ts": "export const handler = () => {};" };
    expect(() => infra(source, extra)).not.toThrow();
  });

  it("fails when no export * provides the entry", () => {
    const source = handlerModule.replace(
      /export const handler[\s\S]*$/,
      `export * from "./entry";\n`,
    );
    const extra = { "runtime/entry.ts": "export const other = () => {};" };
    expect(() => infra(source, extra)).toThrow(
      "runtime/handler.ts: the module declares a function with $lambda, so it must export `handler`",
    );
  });
});

describe("stripForRuntime", () => {
  const runtimeSource = handlerModule.replace(
    ", { infra: ordersQueue.arn }",
    ", ordersQueue.arn",
  );

  it("reduces the declaration to its runtime options", () => {
    const { analysis, analyses } = setup(runtimeSource);
    const { code } = stripForRuntime(analysis, analyses)!;
    expect(code).toContain(
      `export const lambda = $lambda({
  id: "process-orders",
  event: () => sqs(Order, undefined),
  env: () => ({ QUEUE_URL: undefined, LOG_LEVEL: undefined }),
});`,
    );
    expect(code).toContain("export const handler");
  });

  it("removes an import whose uses it removed, and keeps the others", () => {
    const { analysis, analyses } = setup(runtimeSource);
    const { code } = stripForRuntime(analysis, analyses)!;
    expect(code).not.toContain("../infra/orders");
    expect(code).toContain(`import "./sentry";`);
    expect(code).toContain(`from "@aws-sdk/client-sqs"`);
    expect(code).toContain(`from "./schema"`);
    expect(code).toContain(`from "@notation/aws/lambda"`);
  });

  it("keeps an import that the function still uses", () => {
    const source = runtimeSource.replace(
      "await client.send(config);",
      "await client.send(config, unused);",
    );
    const { analysis, analyses } = setup(source);
    const { code } = stripForRuntime(analysis, analyses)!;
    expect(code).toContain(
      `import { ordersQueue, unused } from "../infra/orders";`,
    );
  });

  it("keeps an import that the function uses as a JSX tag", () => {
    const view = path.join(root, "runtime/view.tsx");
    const marks = virtualMarks(
      {
        ...files,
        "runtime/badge.tsx": `export const Badge = () => null;`,
        "runtime/view.tsx": [
          `import { $lambda } from "@notation/aws/lambda";`,
          `import { Badge } from "./badge";`,
          `export const lambda = $lambda({ id: "view", policy: () => [Badge] });`,
          `export const handler = () => <Badge />;`,
        ].join("\n"),
      },
      packages,
    );
    const analysis = analyzeModule(marks.table(view)!, marks);
    const { code } = stripForRuntime(
      analysis,
      new ModuleAnalyses({ marks, root }),
    )!;
    expect(code).not.toContain("policy");
    expect(code).toContain(`import { Badge } from "./badge";`);
  });

  it("removes the last option with the comma before it", () => {
    const source = `
      import { $lambda } from "@notation/aws/lambda";
      export const lambda = $lambda({ event: () => null, memory: 1, id: "a", timeout: 2 });
      export const handler = 1;
    `;
    const { analysis, analyses } = setup(source);
    expect(stripForRuntime(analysis, analyses)!.code).toContain(
      '$lambda({ event: () => null, id: "a" });',
    );
  });

  it("fails when a kept option refers to an infra module", () => {
    const { analysis, analyses } = setup(
      runtimeSource.replace(
        "sqs(Order, ordersQueue.arn)",
        "sqs(ordersQueue.schema)",
      ),
    );
    expect(() => stripForRuntime(analysis, analyses)).toThrow(
      'runtime/handler.ts:16:20: an option of $lambda that the function keeps refers to ordersQueue, from infra/orders.ts, an infra module (files.infra: "infra/**", the default).',
    );
  });

  describe("a resource in a runtime argument", () => {
    const source = runtimeSource.replace(
      "sqs(Order, ordersQueue.arn)",
      "sqs(ordersQueue)",
    );
    const strip = (
      infraFiles: Record<string, string>,
      handler: string = source,
    ) => {
      const marks = virtualMarks(
        {
          ...files,
          "runtime/handler.ts": handler,
          "shared/schema.ts": `export const Order = {};`,
          ...infraFiles,
        },
        {
          ...packages,
          "shared/schema": "shared/schema.ts",
          "@acme/schemas": "node_modules/@acme/schemas/index.js",
        },
      );
      const analysis = analyzeModule(marks.table(file)!, marks);
      return stripForRuntime(analysis, new ModuleAnalyses({ marks, root }))!;
    };

    it("becomes the resource's runtime options, imported from a shared module", () => {
      const { code } = strip({
        "infra/orders.ts": [
          `import { createQueue } from "@notation/aws/sqs";`,
          `import { Order } from "../shared/schema";`,
          `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
        ].join("\n"),
      });
      expect(code).toContain(
        `import { Order as __notation_schema_0 } from "/project/shared/schema.ts";`,
      );
      expect(code).toContain(
        "event: () => sqs({ schema: __notation_schema_0 }),",
      );
      expect(code).not.toContain("../infra/orders");
    });

    it("imports a schema from a tsconfig alias by its absolute path", () => {
      const { code } = strip({
        "infra/orders.ts": [
          `import { createQueue } from "@notation/aws/sqs";`,
          `import { Order } from "shared/schema";`,
          `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
        ].join("\n"),
      });
      expect(code).toContain(
        `import { Order as __notation_schema_0 } from "/project/shared/schema.ts";`,
      );
    });

    it("imports a schema from a package by the package's name", () => {
      const { code } = strip({
        "infra/orders.ts": [
          `import { createQueue } from "@notation/aws/sqs";`,
          `import { Order } from "@acme/schemas";`,
          `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
        ].join("\n"),
        "node_modules/@acme/schemas/index.js": `export const Order = {};`,
      });
      expect(code).toContain(
        `import { Order as __notation_schema_0 } from "@acme/schemas";`,
      );
    });

    it("fails when the schema's import doesn't resolve", () => {
      expect(() =>
        strip({
          "infra/orders.ts": [
            `import { createQueue } from "@notation/aws/sqs";`,
            `import { Order } from "../shared/missing";`,
            `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
          ].join("\n"),
        }),
      ).toThrow(
        `infra/orders.ts:3:56: the build can't resolve "../shared/missing", where the schema of ordersQueue is imported from. The function in runtime/handler.ts reads it.`,
      );
    });

    const queueModule = (...lines: string[]) =>
      [
        `import { createQueue } from "@notation/aws/sqs";`,
        `import { Order } from "../shared/schema";`,
        ...lines,
      ].join("\n");
    const withArgument = (argument: string, importLine?: string) => {
      let handler = source.replace("sqs(ordersQueue)", `sqs(${argument})`);
      if (importLine)
        handler = handler.replace(
          `import { ordersQueue, unused } from "../infra/orders";`,
          importLine,
        );
      return handler;
    };

    it.each([
      [
        "a member of an object literal",
        "queues.orders",
        `export const queues = { orders: createQueue({ id: "orders", schema: Order }) };`,
      ],
      [
        "a computed member with a string key",
        `queues["orders"]`,
        `export const queues = { "orders": createQueue({ id: "orders", schema: Order }) };`,
      ],
      [
        "a shorthand member that names a const",
        "queues.orders",
        `const orders = createQueue({ id: "orders", schema: Order });\nexport const queues = { orders };`,
      ],
      [
        "a nested member",
        "queues.sales.orders",
        `export const queues = { sales: { orders: createQueue({ id: "orders", schema: Order }) } };`,
      ],
    ])("follows %s", (_, argument, line) => {
      const { code } = strip(
        { "infra/orders.ts": queueModule(line) },
        withArgument(
          argument,
          `import { queues, unused } from "../infra/orders";`,
        ),
      );
      expect(code).toContain("sqs({ schema: __notation_schema_0 })");
      expect(code).not.toContain("../infra/orders");
    });

    it.each([
      [
        "a const",
        "() => { const ordersQueue = { schema: undefined }; return sqs(ordersQueue); }",
      ],
      [
        "a parameter",
        "(ordersQueue = { schema: undefined }) => sqs(ordersQueue)",
      ],
    ])("leaves a name that %s shadows", (_, event) => {
      const handler = source.replace("() => sqs(ordersQueue)", event);
      const { code } = strip(
        {
          "infra/orders.ts": queueModule(
            `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
          ),
        },
        handler,
      );
      expect(code).toContain(`event: ${event},`);
      expect(code).not.toContain("__notation_");
    });

    it("follows a member of a namespace import", () => {
      const { code } = strip(
        {
          "infra/orders.ts": queueModule(
            `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
          ),
        },
        withArgument(
          "infra.ordersQueue",
          `import * as infra from "../infra/orders";`,
        ),
      );
      expect(code).toContain("sqs({ schema: __notation_schema_0 })");
    });

    it("fails when a helper makes the object that holds the resource", () => {
      expect(() =>
        strip(
          {
            "infra/orders.ts": queueModule(
              `const makeQueues = () => ({ orders: createQueue({ id: "orders", schema: Order }) });`,
              `export const queues = makeQueues();`,
            ),
          },
          withArgument(
            "queues.orders",
            `import { queues, unused } from "../infra/orders";`,
          ),
        ),
      ).toThrow(
        "runtime/handler.ts:16:20: the function reads queues.orders from infra/orders.ts",
      );
    });

    it("gives the infra error for a member of a resource", () => {
      expect(() =>
        strip(
          {
            "infra/orders.ts": queueModule(
              `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
            ),
          },
          withArgument("ordersQueue.schema"),
        ),
      ).toThrow(
        "an option of $lambda that the function keeps refers to ordersQueue",
      );
    });

    it("follows a re-export to the resource", () => {
      const { code } = strip({
        "infra/orders.ts": `export { ordersQueue } from "./queues";`,
        "infra/queues.ts": [
          `import { createQueue } from "@notation/aws/sqs";`,
          `import { Order } from "../shared/schema";`,
          `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
        ].join("\n"),
      });
      expect(code).toContain("sqs({ schema: __notation_schema_0 })");
    });

    it("has no options when the resource has none", () => {
      const { code } = strip({
        "infra/orders.ts": [
          `import { createQueue } from "@notation/aws/sqs";`,
          `export const ordersQueue = createQueue({ id: "orders" });`,
        ].join("\n"),
      });
      expect(code).toContain("sqs({})");
    });

    it("gives the infra error for a resource whose mark lists no runtime options", () => {
      expect(() =>
        strip({
          "infra/orders.ts": [
            `import { createTopic } from "@notation/aws/sqs";`,
            `export const ordersQueue = createTopic({ id: "orders" });`,
          ].join("\n"),
        }),
      ).toThrow(
        "an option of $lambda that the function keeps refers to ordersQueue",
      );
    });

    const notAName =
      'must be a name that infra/orders.ts imports directly from a shared module (files.shared), such as `schema: Order` with `import { Order } from "../shared/schema"`, because the function in runtime/handler.ts reads it.';

    it.each([
      ["infra defines the schema", [`const Order = {};`], "Order"],
      [
        "the schema is a member of a namespace import",
        [`import * as schemas from "../shared/schema";`],
        "schemas.Order",
      ],
      [
        "the schema is a call on an import",
        [`import { Order } from "../shared/schema";`],
        "Order.extend({})",
      ],
    ])("fails when %s", (_, lines, value) => {
      const queue = `export const ordersQueue = createQueue({ id: "orders", schema: ${value} });`;
      expect(() =>
        strip({
          "infra/orders.ts": [
            `import { createQueue } from "@notation/aws/sqs";`,
            ...lines,
            queue,
          ].join("\n"),
        }),
      ).toThrow(`infra/orders.ts:3:56: the schema of ordersQueue ${notAName}`);
    });

    it.each([
      ["an infra module", "infra/schema.ts"],
      ["a runtime module", "runtime/schema.ts"],
    ])("fails when the schema is imported from %s", (_, schemaFile) => {
      expect(() =>
        strip({
          "infra/orders.ts": [
            `import { createQueue } from "@notation/aws/sqs";`,
            `import { Order } from "../${schemaFile.replace(".ts", "")}";`,
            `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
          ].join("\n"),
          "infra/schema.ts": `export const Order = {};`,
        }),
      ).toThrow(
        "infra/orders.ts:3:56: the schema of ordersQueue must be imported from a shared module (files.shared), because the function in runtime/handler.ts reads it.",
      );
    });

    it("fails when a helper makes the resource", () => {
      expect(() =>
        strip({
          "infra/orders.ts": [
            `import { createQueue } from "@notation/aws/sqs";`,
            `import { Order } from "../shared/schema";`,
            `const makeQueue = (id, schema) => createQueue({ id, schema });`,
            `export const ordersQueue = makeQueue("orders", Order);`,
          ].join("\n"),
        }),
      ).toThrow(
        "runtime/handler.ts:16:20: the function reads ordersQueue from infra/orders.ts, so the build has to find the options of ordersQueue that the function uses.",
      );
    });
  });

  it("fails for a keys option that isn't an object literal", () => {
    const source = runtimeSource.replace(
      `env: () => ({ QUEUE_URL: ordersQueue.url, LOG_LEVEL: "info" })`,
      `env: () => ({ ...base })`,
    );
    const { analysis, analyses } = setup(source);
    expect(() => stripForRuntime(analysis, analyses)).toThrow(
      "the env option of $lambda must be a function that returns an object literal",
    );
  });
});
