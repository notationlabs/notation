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
import esbuild from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setConfigFile } from "@notation/core";
import { infraPlugin } from "src/plugins/infra-plugin";
import {
  buildVirtual,
  projectRoot,
  readVirtualFile,
} from "test/esbuild-test-utils";

const buildInfra = (
  files: Record<string, string>,
  runtimeModules = ["**/*.fn.ts"],
  onRuntimeModules?: (modules: string[]) => void,
) =>
  buildVirtual(files, "infra/main.ts", [
    infraPlugin({
      runtimeModules,
      getFile: readVirtualFile(files),
      runtimeLink: "@notation/resource",
      onRuntimeModules,
    }),
  ]);

describe("in memory", () => {
  beforeAll(() => setConfigFile(path.join(projectRoot, "notation.config.ts")));
  afterAll(() => setConfigFile(undefined));

  const checkout = `
    import { lambda } from "@notation/aws/lambda" with { type: "infra" };
    import { orderQueue } from "../infra/orders" with { type: "infra" };
    import { connect } from "./db";

    console.log("runtime init");
    const db = connect();

    const { handle } = lambda({ id: "checkout", grants: [orderQueue.grant(["SendMessage"])] });
    export const processOrder = handle.sqsEvent(async () => { await db.save(); });
    export const helper = () => db;
  `;
  const files = {
    "infra/main.ts": `
      import * as checkout from "../runtime/checkout.fn" with { type: "runtime" };
      import { orderQueue } from "./orders";
      orderQueue.consume(checkout.processOrder);
    `,
    "infra/orders.ts": `
      import { queue } from "@notation/aws/sqs";
      export const orderQueue = queue({ name: "orders" });
    `,
    "runtime/checkout.fn.ts": checkout,
    "runtime/db.ts": `export const connect = () => { console.log("connecting"); };`,
  };

  it("serves a type: runtime import as stand-ins, and runs the stripped copy after infra", async () => {
    let found: string[] = [];
    const output = await buildInfra(files, undefined, (modules) => {
      found = modules;
    });

    expect(found).toEqual(["/project/runtime/checkout.fn.ts"]);
    expect(output).toContain(
      'createStandIn("runtime/checkout.fn.ts", "processOrder")',
    );
    expect(output).toContain(
      'createStandIn("runtime/checkout.fn.ts", "helper")',
    );
    expect(output).not.toContain("runtime init");
    expect(output).not.toContain("connecting");
    expect(output).not.toContain("db.save");

    const consume = output.indexOf("orderQueue.consume(");
    const declare = output.indexOf('lambda({ id: "checkout"');
    const link = output.indexOf("linkRuntimeModules([");
    expect(consume).toBeGreaterThan(-1);
    expect(declare).toBeGreaterThan(consume);
    expect(link).toBeGreaterThan(declare);
  });

  it("fails when infra imports a runtime module without an attribute", async () => {
    await expect(
      buildInfra({
        ...files,
        "infra/main.ts": `import { processOrder } from "../runtime/checkout.fn"; console.log(processOrder);`,
      }),
    ).rejects.toThrow(
      'runtime/checkout.fn.ts is a runtime module, so infra must import it with { type: "runtime" }',
    );
  });

  it("fails with a migration message for a module that exports resource", async () => {
    const old = `
      import { handle } from "@notation/aws/lambda.fn";
      export const getTodos = handle.apiRequest(() => ({}));
      export const resource = { service: "aws/lambda", id: "todos" };
    `;
    await expect(
      buildInfra({
        "infra/main.ts": `import { getTodos } from "../runtime/todos.fn"; console.log(getTodos);`,
        "runtime/todos.fn.ts": old,
      }),
    ).rejects.toThrow(
      /runtime\/todos\.fn\.ts exports `resource`, which runtime modules no longer use\. Declare the function by calling lambda\(\)/,
    );
    await expect(
      buildInfra({
        "infra/main.ts": `import { getTodos } from "../runtime/todos.fn" with { type: "runtime" }; console.log(getTodos);`,
        "runtime/todos.fn.ts": old,
      }),
    ).rejects.toThrow(/runtime\/todos\.fn\.ts exports `resource`/);
  });

  it("fails when infra imports with type: infra", async () => {
    await expect(
      buildInfra({
        "infra/main.ts": `import { orderQueue } from "./orders" with { type: "infra" }; console.log(orderQueue);`,
        "infra/orders.ts": `export const orderQueue = 1;`,
      }),
    ).rejects.toThrow(
      'with { type: "infra" } is only valid in runtime modules, and infra/main.ts is an infra module',
    );
  });

  it("fails when a type: runtime import names a package", async () => {
    await expect(
      buildInfra({
        "infra/main.ts": `import * as x from "some-package" with { type: "runtime" }; console.log(x);`,
      }),
    ).rejects.toThrow(
      'some-package is imported with { type: "runtime" }, so it must be a runtime module of this project',
    );
  });

  it("follows export * for the stand-ins", async () => {
    const output = await buildInfra({
      "infra/main.ts": `import { a, b } from "../runtime/index.fn" with { type: "runtime" }; console.log(a, b);`,
      "runtime/index.fn.ts": `export * from "./a"; export const b = 1;`,
      "runtime/a.ts": `export const a = 1; export default 2;`,
    });
    expect(output).toContain('createStandIn("runtime/index.fn.ts", "b")');
    expect(output).toContain('createStandIn("runtime/index.fn.ts", "a")');
    expect(output).not.toContain('"default")');
  });
});

describe("evaluated", () => {
  // Inside this package, so the bundle's import of @notation/resource
  // resolves from the package's node_modules.
  const tmpDir = fileURLToPath(new URL("../../tmp", import.meta.url));
  let root: string;

  beforeAll(() => mkdirSync(tmpDir, { recursive: true }));
  afterEach(() => {
    setConfigFile(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const write = (file: string, contents: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  };

  // A provider with one factory, `fn()`, whose handle makes `api` handlers,
  // and one infra API, `route()`, that records what it wires.
  const provider = `
    import {
      createHandlerRef,
      declareRuntimeFunction,
      onEvaluationEnd,
      resolveRuntimeTarget,
    } from "@notation/resource";
    export const wired: string[] = [];
    export function fn(config: { id: string; memory: number }) {
      const f = { config };
      declareRuntimeFunction(f, { id: config.id, service: "test/fn", bundle: "dist/functions/" + config.id + "/index.mjs" }, fn);
      return { handle: { api: function api(_h: unknown) { return createHandlerRef("api", f, api); } } };
    }
    export function route(path: string, target: unknown) {
      onEvaluationEnd(() => {
        const ref = resolveRuntimeTarget(target) as any;
        wired.push(path + " -> " + ref.export + " (memory " + ref.function.config.memory + ")");
      });
    }
  `;

  async function evaluate() {
    root = realpathSync(mkdtempSync(path.join(tmpDir, "infra-plugin-")));
    setConfigFile(path.join(root, "notation.config.ts"));
    write("infra/provider.ts", provider);
    write(
      "infra/main.ts",
      `
      import * as checkout from "../runtime/checkout.fn" with { type: "runtime" };
      import { route, wired } from "./provider";
      route("/orders", checkout.createOrder);
      route("/refunds", checkout.refund);
      export const memory = 256;
      export { wired };
      `,
    );
    write(
      "runtime/checkout.fn.ts",
      `
      import { fn } from "../infra/provider" with { type: "infra" };
      import { memory } from "../infra/main" with { type: "infra" };
      import { refund } from "./refunds";
      console.log("runtime init");
      const { handle } = fn({ id: "checkout", memory });
      export const createOrder = handle.api(() => { console.log("handler ran"); });
      export { refund };
      `,
    );
    write(
      "runtime/refunds.ts",
      `
      import { handle } from "./fn";
      export const refund = handle.api(() => {});
      `,
    );
    write(
      "runtime/fn.ts",
      `
      import { fn } from "../infra/provider" with { type: "infra" };
      export const { handle } = fn({ id: "refunds", memory: 128 });
      `,
    );

    await esbuild.build({
      entryPoints: [path.join(root, "infra/main.ts")],
      outfile: path.join(root, "dist/infra/main.mjs"),
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      logLevel: "silent",
      plugins: [infraPlugin({ runtimeModules: ["runtime/*.fn.ts"] })],
    });

    const script = `
      import { collectResourceGraph } from "@notation/resource";
      let wired;
      const graph = await collectResourceGraph(async () => {
        ({ wired } = await import("./dist/infra/main.mjs"));
      });
      console.log(JSON.stringify({ wired, functions: graph.runtimeFunctions }));
    `;
    return execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: root, encoding: "utf8" },
    );
  }

  it("declares the functions after infra, and links each stand-in to its handler", async () => {
    const output = await evaluate();
    expect(output).not.toContain("runtime init");
    expect(output).not.toContain("handler ran");
    expect(JSON.parse(output)).toEqual({
      wired: [
        "/orders -> createOrder (memory 256)",
        "/refunds -> refund (memory 128)",
      ],
      functions: [
        {
          id: "checkout",
          service: "test/fn",
          bundle: "dist/functions/checkout/index.mjs",
          handlers: [
            {
              module: "runtime/checkout.fn.ts",
              export: "createOrder",
              kind: "api",
            },
          ],
        },
        {
          id: "refunds",
          service: "test/fn",
          bundle: "dist/functions/refunds/index.mjs",
          handlers: [
            { module: "runtime/checkout.fn.ts", export: "refund", kind: "api" },
          ],
        },
      ],
    });
  });
});
