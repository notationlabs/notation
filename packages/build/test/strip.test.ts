import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeModule,
  ModuleAnalyses,
  stripForInfra,
  stripForRuntime,
} from "src/index";
import { createRuntimeEntry } from "src/plugins";
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
  "shared/schema.ts": `export const Order = {};`,
  "infra/orders.ts": `import { createQueue } from "@notation/aws/sqs";\nimport { Order } from "../shared/schema";\nexport const ordersQueue = createQueue({ id: "orders", schema: Order });\nexport const unused = 1;`,
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

// The `exports` of the declaredIn record that the infra copy writes.
const recordedExports = (code: string): string[] =>
  JSON.parse(code.match(/, (\{"exports":.*\})\)/)![1]!).exports;

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
      "function __notation_declaredIn(value, path, binding, moduleExports)",
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
      /** @declaration runtime: handler */
      function createJob(config) { return config; }
      const job = createJob({ id: "job", handler: () => run() });
      export const handler = 1;
    `;
    const { code } = infra(source);
    expect(code).toContain(
      `handler: __notation_unnamed("handler only runs in the function, not in the infra build.")`,
    );
    expect(code).not.toContain("run()");
  });

  it('gives the function that replaces an option that is not a name the name ""', () => {
    const source = `
      import * as ns from "./counter";
      /** @declaration shared: id; runtime: class */
      function $durableObject(config) { return { className: config.class.name }; }
      export const counters = $durableObject({ id: "counters", class: ns.Counter });
    `;
    const extra = { "runtime/counter.ts": "export class Counter {}" };
    const { code } = infra(source, extra);
    expect(code).toContain(`class: __notation_unnamed(`);
    expect(code).not.toContain("./counter");
  });

  it("gives a global name, such as undefined, a function with no name, and doesn't follow it", () => {
    const source = `
      /** @declaration shared: id, label; runtime: class */
      function $durableObject(config) { return config; }
      export const counters = $durableObject({ id: "counters", label: undefined, class: undefined });
    `;
    const { code } = infra(source);
    expect(code).toContain(`class: __notation_unnamed(`);
    expect(code).toContain(`label: undefined`);
  });

  it.each([
    ["a method", "class() { return 1; }"],
    ["an async method", "async class() { return 1; }"],
  ])("replaces a runtime-only option that is %s", (_, option) => {
    const source = `
      /** @declaration shared: id; runtime: class */
      function $durableObject(config) { return config; }
      export const counters = $durableObject({ id: "counters", ${option} });
    `;
    const { code } = infra(source);
    expect(code).toContain(
      `{ id: "counters", class: __notation_unnamed("class only runs in the function, not in the infra build.") }`,
    );
  });

  it("keeps a class that the declaration also uses outside its runtime-only option", () => {
    const source = `
      /** @declaration shared: id, label; runtime: class */
      function $durableObject(config) { return config; }
      export class Counter {}
      export const counters = $durableObject({ id: "counters", label: Counter.name, class: Counter });
    `;
    const { code } = infra(source);
    expect(code).toContain("export class Counter {}");
    expect(code).toContain(`class: function Counter() {`);
  });

  it("names the function that replaces a runtime-only option that names a class", () => {
    const source = `
      import { DurableObject } from "cloudflare:workers";
      /** @declaration shared: id; runtime: class */
      function $durableObject(config) { return config; }
      export class Counter extends DurableObject { fetch() { return 1; } }
      export const counters = $durableObject({ id: "counters", class: Counter });
    `;
    const { code, declaration } = infra(source);
    expect(code).toContain(
      `class: function Counter() { throw new Error("class only runs in the function, not in the infra build."); }`,
    );
    expect(code).not.toContain("cloudflare:workers");
    expect(code).not.toContain("extends DurableObject");
    expect(declaration.entry).toBeUndefined();
  });

  it('gives a class expression in a runtime-only option the name ""', () => {
    const source = `
      /** @declaration runtime: class */
      function createNamespace(config) { return config; }
      const counters = createNamespace({ id: "counters", class: (class Counter {}) });
    `;
    const { code } = infra(source);
    expect(code).toContain(
      `class: __notation_unnamed("class only runs in the function, not in the infra build.")`,
    );
    expect(code).not.toContain("class Counter");
  });

  it("records the other exports of a workerd module, without the declaration", () => {
    const source = `
      /** @declaration shared: id; entry: default; platform: workerd */
      function $worker(config) { return config; }
      export { Counter } from "./counter";
      export const worker = $worker({ id: "api" });
      export default { fetch() {} };
    `;
    const extra = { "runtime/counter.ts": "export class Counter {}" };
    expect(infra(source, extra).declaration).toEqual({
      path: file,
      binding: "worker",
      entry: "default",
      platform: "workerd",
    });
    expect(recordedExports(infra(source, extra).code)).toEqual(["Counter"]);
  });

  it("leaves type-only exports out of a workerd module's other exports", () => {
    const source = `
      import type { Env } from "./env";
      /** @declaration shared: id; entry: default; platform: workerd */
      function $worker(config) { return config; }
      export { Counter, type Options } from "./counter";
      export type { Env };
      export type Handler = () => void;
      export interface Props {}
      export type * from "./types";
      export const worker = $worker({ id: "api" });
      export default { fetch() {} };
    `;
    const extra = { "runtime/counter.ts": "export class Counter {}" };
    expect(recordedExports(infra(source, extra).code)).toEqual(["Counter"]);
  });

  it("leaves types exported without the type keyword out of a workerd module's other exports", () => {
    const source = `
      import type { Env } from "./env";
      import { type Options, Counter } from "./counter";
      /** @declaration shared: id; entry: default; platform: workerd */
      function $worker(config) { return config; }
      interface Local {}
      type Alias = string;
      declare const injected: string;
      interface Merged {}
      class Merged {}
      export { Local, Alias, Env, Options, injected, Counter, Merged };
      export const worker = $worker({ id: "api" });
      export default { fetch() {} };
    `;
    const extra = {
      "runtime/counter.ts":
        "export class Counter {}\nexport type Options = {};",
      "runtime/env.ts": "export type Env = {};",
    };
    expect(recordedExports(infra(source, extra).code)).toEqual([
      "Counter",
      "Merged",
    ]);
  });

  it("records the exports and the export * sources of a workerd module with its declaration", () => {
    const source = `
      /** @declaration shared: id; entry: default; platform: workerd */
      function $worker(config) { return config; }
      export { Counter } from "./counter";
      export * from "./counter";
      export const worker = $worker({ id: "api" });
      export default { fetch() {} };
    `;
    const extra = { "runtime/counter.ts": "export class Counter {}" };
    expect(infra(source, extra).code).toContain(
      `, "runtime/handler.ts", "worker", {"exports":["Counter"],"starExports":["./counter"]})`,
    );
  });

  it("records the platform but no exports for a workerd declaration with no entry", () => {
    const source = `
      /** @declaration shared: id; platform: workerd */
      function $namespace(config) { return config; }
      export class Counter {}
      export const counters = $namespace({ id: "counters" });
    `;
    const { code, declaration } = infra(source);
    expect(declaration).toEqual({
      path: file,
      binding: "counters",
      platform: "workerd",
    });
    expect(code).toContain(`, "runtime/handler.ts", "counters")`);
  });

  it("names the function that replaces a shorthand runtime-only option", () => {
    const source = `
      /** @declaration runtime: job */
      function createJob(config) { return config; }
      function job() {}
      const declared = createJob({ id: "job", job });
      export const handler = 1;
    `;
    expect(infra(source).code).toContain(
      `job: function job() { throw new Error("job only runs in the function, not in the infra build."); }`,
    );
  });

  it("names the function that replaces a runtime-only option with a type assertion", () => {
    const source = `
      /** @declaration runtime: class */
      function $durableObject(config) { return config; }
      export class Counter {}
      export const counters = $durableObject({ id: "counters", class: Counter as any });
    `;
    const { code } = infra(source);
    expect(code).toContain(`class: function Counter() {`);
    expect(code).not.toContain("as any");
    expect(code).not.toContain("class Counter");
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
      `export const lambda = /*#__PURE__*/ $lambda({
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

  it("keeps the other arguments of a call that a resource is passed to", () => {
    const { analysis, analyses } = setup(
      handlerModule.replace(
        "apiGateway.schema(Order)",
        "sqs.bind(ordersQueue, { batchSize: 5 })",
      ),
    );
    const { code } = stripForRuntime(analysis, analyses)!;
    expect(code).toContain(
      "event: () => sqs.bind({ schema: __notation_schema_0 }, { batchSize: 5 }),",
    );
    expect(code).not.toContain("../infra/orders");
  });

  it("keeps an import from a package that isn't infra", () => {
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
          `eventBridge.defineSchedule({ id: "nightly", schedule: rate(1, "day") })`,
        ),
    );
    const { code } = stripForRuntime(analysis, analyses)!;
    expect(code).toContain(
      `event: () => eventBridge.defineSchedule({ id: "nightly", schedule: rate(1, "day") }),`,
    );
    expect(code).toContain(
      `import { rate } from "@notation/aws/event-bridge";`,
    );
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
      'runtime/handler.ts:16:34: ordersQueue can\'t be used in the `event` option of $lambda(), which the function uses, because it comes from infra/orders.ts, an infra module (files.infra: "infra/**", the default), and an infra module only runs at deploy.',
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
        "ordersQueue can't be used in the `event` option of $lambda(), which the function uses, because it comes from infra/orders.ts",
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

    it("follows a barrel whose export * leads back to itself", () => {
      const { code } = strip({
        "infra/orders.ts": `export * from "./a";\nexport * from "./queues";`,
        "infra/a.ts": `export * from "./orders";`,
        "infra/queues.ts": queueModule(
          `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
        ),
      });
      expect(code).toContain("sqs.bind({ schema: __notation_schema_0 })");
    });

    it("follows a default export", () => {
      const { code } = strip(
        {
          "infra/orders.ts": queueModule(
            `export default createQueue({ id: "orders", schema: Order });`,
          ),
        },
        withArgument(
          "ordersQueue",
          `import ordersQueue from "../infra/orders";`,
        ),
      );
      expect(code).toContain("sqs.bind({ schema: __notation_schema_0 })");
      expect(code).not.toContain("../infra/orders");
    });

    it("gives the infra error when a let holds the resource", () => {
      expect(() =>
        strip({
          "infra/orders.ts": queueModule(
            `export let ordersQueue = createQueue({ id: "orders", schema: Order });`,
          ),
        }),
      ).toThrow(
        "runtime/handler.ts:16:25: ordersQueue can't be used in the `event` option of $lambda(), which the function uses, because it comes from infra/orders.ts, an infra module",
      );
    });

    it("fails when a const of the module holds the resource", () => {
      const handler = withArgument("local").replace(
        "export const lambda",
        "const local = ordersQueue;\n\nexport const lambda",
      );
      expect(() =>
        strip(
          {
            "infra/orders.ts": queueModule(
              `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
            ),
          },
          handler,
        ),
      ).toThrow(
        "runtime/handler.ts:18:25: local holds ordersQueue, from infra/orders.ts. Pass ordersQueue to the call directly, so the build can replace it with the resource's runtime options.",
      );
    });

    it("adds its imports after a hashbang line", () => {
      const { code } = strip(
        {
          "infra/orders.ts": queueModule(
            `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
          ),
        },
        `#!/usr/bin/env node${source}`,
      );
      expect(code).toMatch(
        /^#!\/usr\/bin\/env node\nimport \{ Order as __notation_schema_0 \}/,
      );
    });

    it("leaves a resource in a keys option's value", () => {
      const handler = source.replace(
        "QUEUE_URL: ordersQueue.url",
        "QUEUE_URL: sqs.bind(ordersQueue)",
      );
      const { code } = strip(
        {
          "infra/orders.ts": queueModule(
            `export const ordersQueue = createQueue({ id: "orders", schema: Order });`,
          ),
        },
        handler,
      );
      expect(code).toContain(
        "env: () => ({ QUEUE_URL: undefined, LOG_LEVEL: undefined }),",
      );
    });

    // The real queue() requires a schema, but the strip handles any resource
    // whose call leaves out a runtime option.
    it("has no options when the call sets none of the resource's runtime options", () => {
      const { code } = strip({
        "infra/orders.ts": [
          `import { createQueue } from "@notation/aws/sqs";`,
          `export const ordersQueue = createQueue({ id: "orders" });`,
        ].join("\n"),
      });
      expect(code).toContain("sqs.bind({})");
    });

    it("fails when a spread can hold a runtime option", () => {
      expect(() =>
        strip({
          "infra/orders.ts": [
            `import { createQueue } from "@notation/aws/sqs";`,
            `import { Order } from "../shared/schema";`,
            `const base = { schema: Order };`,
            `export const ordersQueue = createQueue({ ...base, id: "orders" });`,
          ].join("\n"),
        }),
      ).toThrow(
        "infra/orders.ts:4:42: ordersQueue has a spread, so the build can't tell whether it sets the schema that the function in runtime/handler.ts reads. Write schema in the object literal of ordersQueue.",
      );
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
        "ordersQueue can't be used in the `event` option of $lambda(), which the function uses, because it comes from infra/orders.ts",
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
      [
        "an infra module",
        "infra/schema.ts",
        'can\'t be used in the function in runtime/handler.ts, because it comes from infra/schema.ts, an infra module (files.infra: "infra/**", the default), and an infra module only runs at deploy.',
      ],
      [
        "a runtime module",
        "runtime/schema.ts",
        "is used both at deploy and in the function in runtime/handler.ts, so it can't come from runtime/schema.ts, a runtime module (files.runtime: \"runtime/**\", the default), which doesn't run as written at deploy.",
      ],
    ])(
      "fails when the schema is imported from %s",
      (_, schemaFile, problem) => {
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
          `infra/orders.ts:3:56: the schema of ordersQueue ${problem} Import the schema from a shared module (files.shared).`,
        );
      },
    );

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
            `export const dlq = createQueue({ id: "dlq", schema: Order });`,
          ].join("\n"),
        }),
      ).toThrow(
        "infra/orders.ts:3:56: the schema of ordersQueue can't be used in the function in runtime/handler.ts, because it comes from lib/schema.ts, and loading lib/schema.ts calls createQueue(), which only runs at deploy. Move the schema to a shared module (files.shared).",
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
        "runtime/handler.ts:16:25: the function reads ordersQueue from infra/orders.ts, but ordersQueue isn't a call to a resource function, so the build can't find its options. If ordersQueue is a resource, declare it with a call such as `queue({ id: \"orders\", schema: Order })`, as a top-level const or in an object literal. If it is a plain value, such as a schema, move it to a shared module (files.shared).",
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
        `export const ordersApi = api({ id: "orders" });`,
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
    const userAuth = `export const userAuth = jwtAuthorizer({ id: "user-auth", api: ordersApi, issuer: "https://issuer", audience: ["app"], claims: Claims });`;

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
        `apiGateway.bind(ordersApi).defineRoute({ method: "GET", path: "/orders", schema: null, auth })`,
        [userAuth.replace("userAuth", "auth")],
        `import { ordersApi, auth } from "../infra/api";`,
      );
      expect(code).toContain(
        `defineRoute({ method: "GET", path: "/orders", schema: null, auth: { claims: __notation_claims_0 } })`,
      );
    });

    it("replaces an authorizer with no claims with {}", () => {
      const code = strip(
        `apiGateway.bind(ordersApi).defineRoute({ method: "GET", path: "/orders", schema: null, auth: userAuth })`,
        [
          `export const userAuth = jwtAuthorizer({ id: "user-auth", api: ordersApi, issuer: "https://issuer", audience: ["app"] });`,
        ],
      );
      expect(code).toContain(
        `apiGateway.bind({}).defineRoute({ method: "GET", path: "/orders", schema: null, auth: {} })`,
      );
      expect(code).not.toContain("__notation_");
    });

    it("leaves a route with no auth option", () => {
      const code = strip(
        `apiGateway.bind(ordersApi).defineRoute({ method: "GET", path: "/orders", schema: null })`,
        [],
        `import { ordersApi } from "../infra/api";`,
      );
      expect(code).toContain(
        `apiGateway.bind({}).defineRoute({ method: "GET", path: "/orders", schema: null })`,
      );
      expect(code).not.toContain("../infra/api");
    });

    it("fails when the auth option refers to an infra value that isn't a resource with runtime options", () => {
      expect(() =>
        strip(
          `apiGateway.bind(ordersApi).defineRoute({ method: "GET", path: "/orders", schema: null, auth: userAuth.claims })`,
          [userAuth],
        ),
      ).toThrow(
        "userAuth can't be used in the `event` option of $lambda(), which the function uses, because it comes from infra/api.ts",
      );
    });
  });

  describe("a rule that a declaration binds to an event bus", () => {
    const strip = (event: string, infraLines: string[], importLine: string) => {
      const handler = handlerModule
        .replace(
          `event: () => apiGateway.schema(Order),`,
          `event: () => ${event},`,
        )
        .replace(
          `import { ordersQueue, unused } from "../infra/orders";`,
          importLine,
        )
        .replace(
          `import { $lambda, apiGateway, sqs, type LambdaHandler }`,
          `import { $lambda, apiGateway, eventBridge, sqs, type LambdaHandler }`,
        )
        .replace(/  policy: .*\n  env: .*\n/, "");
      const marks = virtualMarks(
        {
          ...files,
          "runtime/handler.ts": handler,
          "infra/bus.ts": [
            `import { eventBus, defaultEventBus } from "@notation/aws/event-bridge";`,
            ...infraLines,
          ].join("\n"),
        },
        packages,
      );
      const analysis = analyzeModule(marks.table(file)!, marks);
      return stripForRuntime(analysis, new ModuleAnalyses({ marks, root }))!
        .code;
    };

    it("replaces a bus from eventBus() with {}", () => {
      const code = strip(
        `eventBridge.bind(ordersBus).defineRule({ id: "order-placed", pattern: { source: ["shop"] }, schema: Order })`,
        [`export const ordersBus = eventBus({ id: "orders" });`],
        `import { ordersBus } from "../infra/bus";`,
      );
      expect(code).toContain(
        `event: () => eventBridge.bind({}).defineRule({ id: "order-placed", pattern: { source: ["shop"] }, schema: Order }),`,
      );
      expect(code).not.toContain("../infra/bus");
    });

    it("replaces the default bus with {}", () => {
      const code = strip(
        `eventBridge.bind(defaultBus).defineRule({ id: "uploads", pattern: { source: ["aws.s3"] }, schema: Order })`,
        [`export const defaultBus = defaultEventBus();`],
        `import { defaultBus } from "../infra/bus";`,
      );
      expect(code).toContain(`eventBridge.bind({}).defineRule(`);
      expect(code).not.toContain("../infra/bus");
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

describe("createRuntimeEntry", () => {
  it("re-exports the names from the module, and quotes a name that is not an identifier", () => {
    expect(
      createRuntimeEntry("/project/runtime/api.ts", [
        "default",
        "Counter",
        "my-class",
      ]),
    ).toBe(
      `export { default, Counter, "my-class" } from "/project/runtime/api.ts";\n`,
    );
  });
});
