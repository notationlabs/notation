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
import { $lambda, apiGateway, sqs, type LambdaHandler } from "@notation/aws/lambda";
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
  event: () => apiGateway.schema(Order),
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
  "runtime/schema.ts": `export const Order = {};\nexport const Claims = {};\nexport type OrderType = {};`,
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
      `import { $lambda, apiGateway } from "@notation/aws/lambda";`,
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
    [
      "a const in a block",
      "if (x) { const Order = 1; } return apiGateway.schema(Order);",
    ],
    [
      "a function in a block",
      "{ function Order() {} } return apiGateway.schema(Order);",
    ],
    [
      "a const in a for head",
      "for (const Order of []) {} return apiGateway.schema(Order);",
    ],
    [
      "a catch parameter",
      "try {} catch (Order) {} return apiGateway.schema(Order);",
    ],
    [
      "a case of a switch",
      "switch (x) { case 1: { let Order; } } return apiGateway.schema(Order);",
    ],
  ])("keeps an import that %s doesn't shadow outside it", (_, body) => {
    const source = handlerModule.replace(
      "event: () => apiGateway.schema(Order)",
      `event: () => { ${body} }`,
    );
    expect(infra(source).code).toContain(`import { Order } from "./schema";`);
  });

  it("drops an import that a var in a block shadows in its function", () => {
    const source = handlerModule.replace(
      "event: () => apiGateway.schema(Order)",
      "event: () => { if (x) { var Order = 1; } return apiGateway.schema(Order); }",
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
  it("reduces the declaration to its runtime options", () => {
    const { analysis, analyses } = setup();
    const { code } = stripForRuntime(analysis, analyses)!;
    expect(code).toContain(
      `export const lambda = $lambda({
  id: "process-orders",
  event: () => apiGateway.schema(Order),
  env: () => ({ QUEUE_URL: undefined, LOG_LEVEL: undefined }),
});`,
    );
    expect(code).toContain("export const handler");
  });

  it("leaves apiGateway.schema(Order).authSchema(Claims) as it is", () => {
    const { analysis, analyses } = setup(
      handlerModule
        .replace(
          `import { Order, type OrderType } from "./schema";`,
          `import { Claims, Order, type OrderType } from "./schema";`,
        )
        .replace(
          "apiGateway.schema(Order)",
          "apiGateway.schema(Order).authSchema(Claims)",
        ),
    );
    const { code } = stripForRuntime(analysis, analyses)!;
    expect(code).toContain(
      "event: () => apiGateway.schema(Order).authSchema(Claims),",
    );
    expect(code).toContain(
      `import { Claims, Order, type OrderType } from "./schema";`,
    );
  });

  it("replaces an argument that the @runtime mark doesn't name with undefined, even one that reads infra", () => {
    const { analysis, analyses } = setup(
      handlerModule.replace(
        "apiGateway.schema(Order)",
        "sqs.bind(ordersQueue, { batchSize: unused })",
      ),
    );
    const { code } = stripForRuntime(analysis, analyses)!;
    expect(code).toContain("event: () => sqs.bind({}, undefined),");
    expect(code).not.toContain("../infra/orders");
  });

  it("replaces each argument of a @runtime mark with no names with undefined", () => {
    const { analysis, analyses } = setup(
      handlerModule
        .replace(
          `import { Order, type OrderType } from "./schema";`,
          `import { Order, type OrderType } from "./schema";\nimport { rate } from "@notation/aws/event-bridge";`,
        )
        .replace(
          `import { $lambda, apiGateway, sqs, type LambdaHandler }`,
          `import { $lambda, eventBridge, type LambdaHandler }`,
        )
        .replace(
          "apiGateway.schema(Order)",
          `eventBridge.defineSchedule({ name: "nightly", schedule: rate(1, "day") })`,
        ),
    );
    const { code } = stripForRuntime(analysis, analyses)!;
    expect(code).toContain(
      "event: () => eventBridge.defineSchedule(undefined),",
    );
    expect(code).not.toContain("@notation/aws/event-bridge");
  });

  it("removes an import whose uses it removed, and keeps the others", () => {
    const { analysis, analyses } = setup();
    const { code } = stripForRuntime(analysis, analyses)!;
    expect(code).not.toContain("../infra/orders");
    expect(code).toContain(`import "./sentry";`);
    expect(code).toContain(`from "@aws-sdk/client-sqs"`);
    expect(code).toContain(`from "./schema"`);
    expect(code).toContain(`from "@notation/aws/lambda"`);
  });

  it("keeps an import that the function still uses", () => {
    const source = handlerModule.replace(
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
      handlerModule.replace(
        "apiGateway.schema(Order)",
        "apiGateway.schema(ordersQueue.schema)",
      ),
    );
    expect(() => stripForRuntime(analysis, analyses)).toThrow(
      'runtime/handler.ts:16:34: an option of $lambda that the function keeps refers to ordersQueue, from infra/orders.ts, an infra module (files.infra: "infra/**", the default).',
    );
  });

  describe("a resource in a runtime argument", () => {
    const source = handlerModule.replace(
      "apiGateway.schema(Order)",
      "sqs.bind(ordersQueue)",
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
        "event: () => sqs.bind({ schema: __notation_schema_0 }),",
      );
      expect(code).not.toContain("../infra/orders");
    });

    it("leaves sqs.schema() with a schema from a shared module", () => {
      const handler = source
        .replace("sqs.bind(ordersQueue)", "sqs.schema(Order)")
        .replace(`from "./schema"`, `from "../shared/schema"`);
      const { code } = strip({}, handler);
      expect(code).toContain("event: () => sqs.schema(Order),");
      expect(code).toContain(
        `import { Order, type OrderType } from "../shared/schema";`,
      );
      expect(code).not.toContain("__notation_");
    });

    it.each([
      [
        "a mark on a function that a member names",
        [
          `/** @declaration shared: id, event, env; keys: env; entry: handler */`,
          `export function $lambda(config) { return config; }`,
          `/** @runtime queue */`,
          `function bindQueue(queue) { return { kind: "sqs", schema: queue?.schema }; }`,
          `export const sqs = { bind: bindQueue };`,
        ].join("\n"),
        {},
      ],
      [
        "a mark on a member of an object that a compiled chunk exports",
        `export { u as sqs, $lambda } from "./chunk.js";`,
        {
          "node_modules/@notation/aws/chunk.js": [
            `/** @declaration shared: id, event, env; keys: env; entry: handler */`,
            `function $lambda(config) { return config; }`,
            `const sqs = {`,
            `  /** @runtime queue */`,
            `  bind(queue, options) { return { kind: "sqs", schema: queue?.schema }; },`,
            `};`,
            `export { sqs as u, $lambda };`,
          ].join("\n"),
        },
      ],
    ])("finds %s", (_, lambdaModule, extra) => {
      const { code } = strip({
        "node_modules/@notation/aws/lambda.js": lambdaModule,
        ...extra,
        "infra/orders.ts": [
          `import { createQueue } from "@notation/aws/sqs";`,
          `import { Order } from "../shared/schema";`,
          `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
        ].join("\n"),
      });
      expect(code).toContain(
        "event: () => sqs.bind({ schema: __notation_schema_0 }),",
      );
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
      let handler = source.replace(
        "sqs.bind(ordersQueue)",
        `sqs.bind(${argument})`,
      );
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
      expect(code).toContain("sqs.bind({ schema: __notation_schema_0 })");
      expect(code).not.toContain("../infra/orders");
    });

    it.each([
      [
        "a const",
        "() => { const ordersQueue = undefined; return sqs.bind(ordersQueue); }",
      ],
      ["a parameter", "(ordersQueue = undefined) => sqs.bind(ordersQueue)"],
    ])("leaves a name that %s shadows", (_, event) => {
      const handler = source.replace("() => sqs.bind(ordersQueue)", event);
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
      expect(code).toContain("sqs.bind({ schema: __notation_schema_0 })");
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
        "runtime/handler.ts:16:25: the function reads queues.orders from infra/orders.ts",
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
      expect(code).toContain("sqs.bind({ schema: __notation_schema_0 })");
    });

    it("has no options when the resource has none", () => {
      const { code } = strip({
        "infra/orders.ts": [
          `import { createQueue } from "@notation/aws/sqs";`,
          `export const ordersQueue = createQueue({ id: "orders" });`,
        ].join("\n"),
      });
      expect(code).toContain("sqs.bind({})");
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

    it("imports a schema from a file that no glob matches by its absolute path", () => {
      const { code } = strip({
        "infra/orders.ts": [
          `import { createQueue } from "@notation/aws/sqs";`,
          `import { Order } from "../lib/schema";`,
          `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
        ].join("\n"),
        "lib/schema.ts": `export const Order = {};`,
      });
      expect(code).toContain(
        `import { Order as __notation_schema_0 } from "/project/lib/schema.ts";`,
      );
    });

    it("fails when the schema's file has no kind and calls a resource function", () => {
      expect(() =>
        strip({
          "infra/orders.ts": [
            `import { createQueue } from "@notation/aws/sqs";`,
            `import { Order } from "../lib/schema";`,
            `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
          ].join("\n"),
          "lib/schema.ts": [
            `import { createQueue } from "@notation/aws/sqs";`,
            `export const Order = {};`,
            `export const dlq = createQueue({ id: "dlq" });`,
          ].join("\n"),
        }),
      ).toThrow(
        "infra/orders.ts:3:56: the schema of ordersQueue is imported from lib/schema.ts, which calls createQueue at its top level, so the function in runtime/handler.ts can't load it. Move the schema to a shared module (files.shared).",
      );
    });

    it("fails when the resource isn't declared with an object literal", () => {
      expect(() =>
        strip({
          "infra/orders.ts": [
            `import { createQueue } from "@notation/aws/sqs";`,
            `const config = { id: "orders" };`,
            `export const ordersQueue = createQueue(config);`,
          ].join("\n"),
        }),
      ).toThrow(
        "infra/orders.ts:3:28: ordersQueue must be declared with an object literal, so the build can find its schema, which the function in runtime/handler.ts reads.",
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
        "runtime/handler.ts:16:25: the function reads ordersQueue from infra/orders.ts, but ordersQueue isn't a call to a resource function, so the build can't find its options. If ordersQueue is a resource, declare it with a call such as `queue({ name: \"orders\", schema: Order })`, as a top-level const or in an object literal. If it is a plain value, such as a schema, move it to a shared module (files.shared).",
      );
    });

    it("gives the same error for a plain value that a call makes", () => {
      expect(() =>
        strip({
          "infra/orders.ts": [
            `import { object } from "valibot";`,
            `export const ordersQueue = object({});`,
          ].join("\n"),
        }),
      ).toThrow(
        "runtime/handler.ts:16:25: the function reads ordersQueue from infra/orders.ts, but ordersQueue isn't a call to a resource function",
      );
    });
  });

  describe("a route that a declaration binds to an API", () => {
    const apiModule = (...lines: string[]) =>
      [
        `import { api, jwtAuthorizer } from "@notation/aws/api-gateway";`,
        `import { Claims } from "../shared/claims";`,
        `export const ordersApi = api({ name: "orders" });`,
        ...lines,
      ].join("\n");
    const strip = (
      event: string,
      infraLines: string[],
      importLine = `import { ordersApi, userAuth } from "../infra/api";`,
      extra: Record<string, string> = {},
    ) => {
      const handler = handlerModule
        .replace(
          `event: () => apiGateway.schema(Order),`,
          `event: () => ${event},`,
        )
        .replace(
          `import { ordersQueue, unused } from "../infra/orders";`,
          importLine,
        );
      const marks = virtualMarks(
        {
          ...files,
          "runtime/handler.ts": handler,
          "shared/claims.ts": `export const Claims = {};`,
          "infra/api.ts": apiModule(...infraLines),
          ...extra,
        },
        packages,
      );
      const analysis = analyzeModule(marks.table(file)!, marks);
      return stripForRuntime(analysis, new ModuleAnalyses({ marks, root }))!
        .code;
    };
    const userAuth = `export const userAuth = jwtAuthorizer({ api: ordersApi, issuer: "https://issuer", audience: ["app"], claims: Claims });`;

    it("replaces the API with {} and the authorizer with its claims", () => {
      const code = strip(
        `apiGateway.bind(ordersApi).defineRoute({ method: "POST", path: "/orders", schema: Order, auth: userAuth })`,
        [userAuth],
      );
      expect(code).toContain(
        `event: () => apiGateway.bind({}).defineRoute({ method: "POST", path: "/orders", schema: Order, auth: { claims: __notation_claims_0 } }),`,
      );
      expect(code).toContain(
        `import { Claims as __notation_claims_0 } from "/project/shared/claims.ts";`,
      );
      expect(code).toContain(
        `import { Order, type OrderType } from "./schema";`,
      );
      expect(code).not.toContain("../infra/api");
    });

    it("replaces a shorthand auth option", () => {
      const code = strip(
        `apiGateway.bind(ordersApi).defineRoute({ method: "GET", path: "/orders", auth })`,
        [userAuth.replace("userAuth", "auth")],
        `import { ordersApi, auth } from "../infra/api";`,
      );
      expect(code).toContain(
        `defineRoute({ method: "GET", path: "/orders", auth: { claims: __notation_claims_0 } })`,
      );
    });

    it("replaces an authorizer with no claims with {}", () => {
      const code = strip(
        `apiGateway.bind(ordersApi).defineRoute({ method: "GET", path: "/orders", auth: userAuth })`,
        [
          `export const userAuth = jwtAuthorizer({ api: ordersApi, issuer: "https://issuer", audience: ["app"] });`,
        ],
      );
      expect(code).toContain(
        `apiGateway.bind({}).defineRoute({ method: "GET", path: "/orders", auth: {} })`,
      );
      expect(code).not.toContain("__notation_");
    });

    it("leaves a route with no auth option", () => {
      const code = strip(
        `apiGateway.bind(ordersApi).defineRoute({ method: "GET", path: "/orders" })`,
        [],
        `import { ordersApi } from "../infra/api";`,
      );
      expect(code).toContain(
        `apiGateway.bind({}).defineRoute({ method: "GET", path: "/orders" })`,
      );
      expect(code).not.toContain("../infra/api");
    });

    it("finds the mark of a method that a named function returns", () => {
      const code = strip(
        `apiGateway.bind(ordersApi).defineRoute({ method: "GET", path: "/orders", auth: userAuth })`,
        [userAuth],
        undefined,
        {
          "node_modules/@notation/aws/lambda.js": [
            `/** @declaration shared: id, event, env; keys: env; entry: handler */`,
            `export function $lambda(config) { return config; }`,
            `/** @runtime api */`,
            `function bindApi(api) {`,
            `  const kind = "apiGateway";`,
            `  return {`,
            `    /** @runtime options.auth */`,
            `    defineRoute(options) { return { kind, claims: options.auth?.claims }; },`,
            `  };`,
            `}`,
            `export const apiGateway = { bind: bindApi };`,
          ].join("\n"),
        },
      );
      expect(code).toContain(
        `apiGateway.bind({}).defineRoute({ method: "GET", path: "/orders", auth: { claims: __notation_claims_0 } })`,
      );
    });

    it("fails when the auth option refers to an infra value that isn't a resource with runtime options", () => {
      expect(() =>
        strip(
          `apiGateway.bind(ordersApi).defineRoute({ method: "GET", path: "/orders", auth: userAuth.claims })`,
          [userAuth],
        ),
      ).toThrow(
        "an option of $lambda that the function keeps refers to userAuth",
      );
    });
  });

  it("fails for a keys option that isn't an object literal", () => {
    const source = handlerModule.replace(
      `env: () => ({ QUEUE_URL: ordersQueue.url, LOG_LEVEL: "info" })`,
      `env: () => ({ ...base })`,
    );
    const { analysis, analyses } = setup(source);
    expect(() => stripForRuntime(analysis, analyses)).toThrow(
      "the env option of $lambda must be a function that returns an object literal",
    );
  });
});
