import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  writeTypesOrWarn,
  renderTypes,
  typesFileName,
  watchTypes,
  writeTypes,
} from "../src/types";

// Inside this package, so the project's imports of @notation packages resolve
// from the package's node_modules, to the built packages.
const tmpDir = fileURLToPath(new URL("../tmp", import.meta.url));

// The repository's TypeScript, which is 7.1: earlier versions can't parse
// attributes on ambient module declarations.
const tsc = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve("typescript/package.json"),
  ),
  "bin/tsc",
);

let root: string;

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
  root = realpathSync(mkdtempSync(path.join(tmpDir, "notation-types-")));
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "esnext",
        target: "esnext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
    }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(file: string, contents: string) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), contents);
}

const read = () => readFileSync(path.join(root, typesFileName), "utf8");

function typecheck() {
  const result = spawnSync(
    process.execPath,
    [tsc, "-p", root, "--pretty", "false"],
    {
      encoding: "utf8",
    },
  );
  return { status: result.status, output: result.stdout + result.stderr };
}

const ordersModule = `
  import { queue } from "@notation/aws/sqs";
  import * as checkout from "../runtime/checkout" with { type: "runtime" };

  export const orderQueue = queue({ name: "orders" });
  orderQueue.consume(checkout.processOrder);

  // @ts-expect-error infra can't call a handler
  checkout.processOrder({ Records: [] });
  // @ts-expect-error an API handler can't consume a queue
  orderQueue.consume(checkout.createOrder);
  // @ts-expect-error infra can't use a helper of a runtime module
  checkout.formatOrder("x");

  const fn: import("@notation/aws/lambda").LambdaFunction = checkout.createOrder.function;
  const arn: string = checkout.createOrder.function.arn;
  // @ts-expect-error infra can't make handlers for a runtime module's function
  checkout.createOrder.function.handle;
  // @ts-expect-error infra can't make handlers for an exported lambda() result
  checkout.checkoutFn.handle;

  export const settings = { id: "checkout", memory: 64 };
`;

const checkoutModule = `
  import { json } from "@notation/aws/lambda.fn";
  import { lambda, isLambdaGroup } from "@notation/aws/lambda" with { type: "infra" };
  import { queue } from "@notation/aws/sqs" with { type: "infra" };
  import { orderQueue, settings } from "../infra/orders" with { type: "infra" };

  const url: string = orderQueue.url;
  export const checkoutFn = lambda({
    id: settings.id,
    memory: settings.memory * 2,
    grants: [orderQueue.grant(["SendMessage"])],
  });
  const { handle } = checkoutFn;

  // @ts-expect-error runtime can't call an infra method other than grant
  orderQueue.consume({} as any);
  // @ts-expect-error runtime can't call an infra function that isn't a factory
  isLambdaGroup(orderQueue);
  // @ts-expect-error runtime can't read its function's role
  checkoutFn.role;
  // @ts-expect-error runtime can't call a factory that has no runtime half
  queue({ name: "x" });
  // @ts-expect-error a binding's resources aren't delivered
  orderQueue.resources;
  // @ts-expect-error a binding's resource isn't delivered
  orderQueue.queue;

  export const formatOrder = (body: string) => body.trim();

  export const createOrder = handle.apiRequest(async () => json({ url }));

  export const processOrder = handle.sqsEvent(async (event) => {
    for (const record of event.Records) console.log(formatOrder(record.body));
  });
`;

describe("renderTypes", () => {
  it("writes a block per attributed specifier and catch-alls per attribute", () => {
    const { contents, warnings } = renderTypes(root, [
      {
        importer: path.join(root, "runtime/checkout.ts"),
        specifier: "../infra/orders",
        type: "infra",
        resolved: path.join(root, "infra/orders.ts"),
      },
      {
        importer: path.join(root, "infra/orders.ts"),
        specifier: "../runtime/checkout",
        type: "runtime",
        resolved: path.join(root, "runtime/checkout.ts"),
      },
      {
        importer: path.join(root, "runtime/checkout.ts"),
        specifier: "@notation/aws/lambda",
        type: "infra",
      },
    ]);
    expect(contents).toMatchInlineSnapshot(`
      "// Generated by \`notation types\`. Do not edit.

      declare module "../infra/orders*" with { type: "infra" } {
        const view: import("@notation/core/types").RuntimeView<typeof import("./infra/orders.js")>;
        export = view;
      }
      declare module "@notation/aws/lambda*" with { type: "infra" } {
        const view: import("@notation/core/types").RuntimeView<typeof import("@notation/aws/lambda")>;
        export = view;
      }
      declare module "../runtime/checkout*" with { type: "runtime" } {
        const view: import("@notation/core/types").InfraView<typeof import("./runtime/checkout.js")>;
        export = view;
      }
      declare module "./*" with { type: "infra" } {
        const view: { readonly [name: string]: { readonly "no generated declaration for this { type: \\"infra\\" } import": "run notation types" } };
        export = view;
      }
      declare module "../*" with { type: "infra" } {
        const view: { readonly [name: string]: { readonly "no generated declaration for this { type: \\"infra\\" } import": "run notation types" } };
        export = view;
      }
      declare module "./*" with { type: "runtime" } {
        const view: { readonly [name: string]: { readonly "no generated declaration for this { type: \\"runtime\\" } import": "run notation types" } };
        export = view;
      }
      declare module "../*" with { type: "runtime" } {
        const view: { readonly [name: string]: { readonly "no generated declaration for this { type: \\"runtime\\" } import": "run notation types" } };
        export = view;
      }
      "
    `);
    expect(warnings).toEqual([]);
  });

  it("writes one block for a specifier that names the same module from two files", () => {
    const orders = path.join(root, "infra/orders.ts");
    const { contents } = renderTypes(root, [
      {
        importer: path.join(root, "runtime/a.ts"),
        specifier: "../infra/orders",
        type: "infra",
        resolved: orders,
      },
      {
        importer: path.join(root, "runtime/b.ts"),
        specifier: "../infra/orders",
        type: "infra",
        resolved: orders,
      },
    ]);
    expect(contents.match(/"\.\.\/infra\/orders\*"/g)).toHaveLength(1);
  });

  it("writes an error block and a warning for a specifier that names two modules from two directories", () => {
    const { contents, warnings } = renderTypes(root, [
      {
        importer: path.join(root, "runtime/checkout.ts"),
        specifier: "../infra/orders",
        type: "infra",
        resolved: path.join(root, "infra/orders.ts"),
      },
      {
        importer: path.join(root, "app/runtime/checkout.ts"),
        specifier: "../infra/orders",
        type: "infra",
        resolved: path.join(root, "app/infra/orders.ts"),
      },
    ]);
    expect(warnings).toEqual([
      expect.stringContaining(
        'The import "../infra/orders" with { type: "infra" } names different modules in app/runtime/checkout.ts, runtime/checkout.ts.',
      ),
    ]);
    expect(contents).toContain(
      `declare module "../infra/orders*" with { type: "infra" } {\n` +
        `  const view: { readonly [name: string]: { readonly "\\"../infra/orders\\" names different modules in app/runtime/checkout.ts, runtime/checkout.ts": "use a different specifier in one of the files" } };`,
    );
  });

  it("writes an error block and a warning for a relative specifier that doesn't resolve", () => {
    const { contents, warnings } = renderTypes(root, [
      {
        importer: path.join(root, "infra/orders.ts"),
        specifier: "../runtime/missing",
        type: "runtime",
      },
    ]);
    expect(warnings).toEqual([
      'The import "../runtime/missing" with { type: "runtime" } in infra/orders.ts doesn\'t resolve to a file.',
    ]);
    expect(contents).toContain(
      `declare module "../runtime/missing*" with { type: "runtime" } {\n` +
        `  const view: { readonly [name: string]: { readonly "\\"../runtime/missing\\" in infra/orders.ts doesn't resolve to a file": "check the path" } };`,
    );
  });
});

describe("writeTypes", () => {
  it("finds attributed imports in the project's source files", async () => {
    write("infra/orders.ts", ordersModule);
    write("runtime/checkout.ts", checkoutModule);
    write("node_modules/pkg/index.ts", ordersModule);
    write("dist/infra/orders.ts", ordersModule);

    expect((await writeTypes(root)).changed).toBe(true);

    const blocks = read().match(
      /^declare module "[^"]+" with \{ type: "\w+" \}/gm,
    );
    expect(blocks).toEqual([
      'declare module "../infra/orders*" with { type: "infra" }',
      'declare module "@notation/aws/lambda*" with { type: "infra" }',
      'declare module "@notation/aws/sqs*" with { type: "infra" }',
      'declare module "../runtime/checkout*" with { type: "runtime" }',
      'declare module "./*" with { type: "infra" }',
      'declare module "../*" with { type: "infra" }',
      'declare module "./*" with { type: "runtime" }',
      'declare module "../*" with { type: "runtime" }',
    ]);
  });

  it("finds re-exports and dynamic imports with attributes", async () => {
    write(
      "infra/index.ts",
      `
      export * from "../runtime/a" with { type: "runtime" };
      const b = await import("../runtime/b", { with: { type: "runtime" } });
      `,
    );
    write("runtime/a.ts", "export const a = 1;");
    write("runtime/b.ts", "export const b = 1;");

    await writeTypes(root);

    expect(read()).toContain('declare module "../runtime/a*"');
    expect(read()).toContain('declare module "../runtime/b*"');
  });

  it("leaves the file as it is when its contents don't change", async () => {
    write("infra/orders.ts", ordersModule);
    write("runtime/checkout.ts", checkoutModule);
    await writeTypes(root);
    const { mtimeMs } = statSync(path.join(root, typesFileName));

    write("runtime/checkout.ts", checkoutModule + "\nexport const more = 1;\n");

    expect((await writeTypes(root)).changed).toBe(false);
    expect(statSync(path.join(root, typesFileName)).mtimeMs).toBe(mtimeMs);
  });

  it("writes the file and warns when one specifier names different modules from two directories", async () => {
    for (const dir of ["a", "b"]) {
      write(
        `${dir}/infra.ts`,
        `import * as handlers from "./handlers" with { type: "runtime" };\nconsole.log(handlers);\n`,
      );
      write(`${dir}/handlers.ts`, `export const x = 1;`);
    }

    const { changed, warnings } = await writeTypes(root);

    expect(changed).toBe(true);
    expect(warnings).toEqual([
      expect.stringContaining(
        "names different modules in a/infra.ts, b/infra.ts",
      ),
    ]);
  });
});

describe("writeTypesOrWarn", () => {
  it("warns and doesn't throw when a source file doesn't parse", async () => {
    write(
      "infra/orders.ts",
      `import * as checkout from "../runtime/checkout" with { type: "runtime" };\nexport const broken = ;\n`,
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await writeTypesOrWarn(root, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`Writing ${typesFileName} failed:`),
    );
  });
});

describe("the generated declarations", () => {
  it("type both views of an infra and a runtime module that import each other", async () => {
    write("infra/orders.ts", ordersModule);
    write("runtime/checkout.ts", checkoutModule);
    await writeTypes(root);

    const { status, output } = typecheck();
    expect(output).toBe("");
    expect(status).toBe(0);
  }, 30_000);

  it("give an attributed import with no block an error type that says to run notation types", async () => {
    write("infra/orders.ts", ordersModule);
    write("runtime/checkout.ts", checkoutModule);
    await writeTypes(root);
    write(
      "infra/new.ts",
      `
      import { queue } from "@notation/aws/sqs";
      import * as billing from "../runtime/billing" with { type: "runtime" };
      import { processOrder } from "../runtime/billing" with { type: "runtime" };
      queue({ name: "a" }).consume(billing.processOrder);
      queue({ name: "b" }).consume(processOrder);
      `,
    );
    write("runtime/billing.ts", checkoutModule);

    const { status, output } = typecheck();
    expect(status).not.toBe(0);
    const errors = output.trim().split("\n");
    expect(errors).toHaveLength(2);
    // An `export =` declaration has no named exports, so a named import fails
    // without the message, but still at the import.
    expect(errors[0]).toContain(
      `infra/new.ts(4,16): error TS2305: Module '"../*"' has no exported member 'processOrder'.`,
    );
    expect(errors[1]).toContain("infra/new.ts(5,");
    expect(errors[1]).toContain(
      `'{ readonly "no generated declaration for this { type: \\"runtime\\" } import": "run notation types"; }'`,
    );
  }, 30_000);

  it("give an attributed import that doesn't resolve an error type that names the specifier and the file", async () => {
    write(
      "infra/orders.ts",
      `
      import { queue } from "@notation/aws/sqs";
      import * as billing from "../runtime/billing" with { type: "runtime" };
      queue({ name: "a" }).consume(billing.processOrder);
      `,
    );
    await writeTypes(root);

    const { status, output } = typecheck();
    expect(status).not.toBe(0);
    expect(output).toContain("infra/orders.ts(4,");
    expect(output).toContain(
      `'{ readonly "\\"../runtime/billing\\" in infra/orders.ts doesn't resolve to a file": "check the path"; }'`,
    );
  }, 30_000);
});

const checkoutView = `InfraView<typeof import("./runtime/checkout.js")>`;

const untilWritten = () =>
  vi.waitFor(() => expect(read()).toContain(checkoutView), {
    timeout: 10_000,
  });

describe("watchTypes", () => {
  it("writes the file again when a file adds an attributed import", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    write("infra/orders.ts", `export const a = 1;`);
    const stop = await watchTypes(root, { logger, debounceMs: 10 });
    try {
      expect(read()).not.toContain(checkoutView);

      // The runtime module first, so that the import of it in orders.ts
      // resolves whenever a run reads orders.ts.
      write("runtime/checkout.ts", checkoutModule);
      write("infra/orders.ts", ordersModule);
      await untilWritten();
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      await stop();
    }
  }, 15_000);

  it("writes the file again when an import that didn't resolve starts to resolve", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    write("infra/orders.ts", ordersModule);
    mkdirSync(path.join(root, "runtime"));
    const stop = await watchTypes(root, { logger, debounceMs: 10 });
    try {
      expect(read()).not.toContain(checkoutView);

      write("runtime/checkout.ts", checkoutModule);
      await untilWritten();
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      await stop();
    }
  }, 15_000);
});
