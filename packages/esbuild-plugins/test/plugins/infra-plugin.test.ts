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
  buildVirtualResult,
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

  const warningsOf = async (
    files: Record<string, string>,
    runtimeModules = ["**/*.fn.ts"],
  ) => {
    const result = await buildVirtualResult(files, "infra/main.ts", [
      infraPlugin({
        runtimeModules,
        getFile: readVirtualFile(files),
        runtimeLink: "@notation/resource",
        listFiles: () =>
          Object.keys(files).map((file) => path.join(projectRoot, file)),
      }),
    ]);
    return result.warnings.map((warning) => warning.text);
  };

  it("warns about a runtime module that calls lambda() but that no infra module imports", async () => {
    const warnings = await warningsOf({
      ...files,
      "runtime/refunds.fn.ts": `
        import { lambda } from "@notation/aws/lambda" with { type: "infra" };
        const { handle } = lambda({ id: "refunds" });
        export const refund = handle.apiRequest(async () => ({}));
      `,
    });
    expect(warnings).toEqual([
      'runtime/refunds.fn.ts matches runtimeModules and imports @notation/aws/lambda with { type: "infra" }, but no infra module imports it with { type: "runtime" }, so its functions aren\'t deployed. To deploy them, import it from infra, as in `import * as handlers from "../runtime/refunds.fn" with { type: "runtime" };` in infra/main.ts, and pass its handlers to infra APIs such as route() or consume().',
    ]);
  });

  it("doesn't warn about modules that a wired runtime module imports, or that don't call a provider factory", async () => {
    const warnings = await warningsOf(
      {
        ...files,
        "runtime/checkout.fn.ts": `
          import { handle } from "./fn";
          export const processOrder = handle.sqsEvent(async () => {});
        `,
        "runtime/fn.ts": `
          import { lambda } from "@notation/aws/lambda" with { type: "infra" };
          export const { handle } = lambda({ id: "checkout" });
        `,
        "runtime/checkout.test.ts": `
          import { processOrder } from "./checkout.fn";
          processOrder({ Records: [] });
        `,
        "runtime/reads.ts": `
          import { orderQueue } from "../infra/orders" with { type: "infra" };
          export const url = () => orderQueue.url;
        `,
      },
      ["runtime/**"],
    );
    expect(warnings).toEqual([]);
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

  it("finds runtime modules that an infra module imported by runtime code imports", async () => {
    let found: string[] = [];
    const output = await buildInfra(
      {
        "infra/main.ts": `
          import { checkout } from "../runtime/checkout.fn" with { type: "runtime" };
          console.log(checkout);
        `,
        "runtime/checkout.fn.ts": `
          import { lambda } from "@notation/aws/lambda" with { type: "infra" };
          import { refunds } from "../infra/refunds" with { type: "infra" };
          const { handle } = lambda({ id: "checkout", grants: [refunds.grant()] });
          export const checkout = handle.apiRequest(() => ({}));
        `,
        "infra/refunds.ts": `
          import { refund } from "../runtime/refund.fn" with { type: "runtime" };
          export const refunds = { grant: () => refund };
        `,
        "runtime/refund.fn.ts": `
          import { lambda } from "@notation/aws/lambda" with { type: "infra" };
          const { handle } = lambda({ id: "refund" });
          export const refund = handle.apiRequest(() => ({}));
        `,
      },
      undefined,
      (modules) => {
        found = modules;
      },
    );
    expect(found).toEqual([
      "/project/runtime/checkout.fn.ts",
      "/project/runtime/refund.fn.ts",
    ]);
    expect(output).toContain('({ id: "refund" })');
    expect(output).toContain('module: "runtime/refund.fn.ts"');
  });

  it("fails when a scanned infra module doesn't show up among the scan's files", async () => {
    const files = {
      "infra/main.ts": `
        import { checkout } from "../runtime/checkout.fn" with { type: "runtime" };
        console.log(checkout);
      `,
      "runtime/checkout.fn.ts": `
        import { lambda } from "@notation/aws/lambda" with { type: "infra" };
        import { refunds } from "../infra/refunds" with { type: "infra" };
        const { handle } = lambda({ id: "checkout", grants: [refunds.grant()] });
        export const checkout = handle.apiRequest(() => ({}));
      `,
      "infra/refunds.ts": `export const refunds = { grant: () => ({}) };`,
      "infra/real/refunds.ts": `export const refunds = { grant: () => ({}) };`,
    };
    // Resolves infra/refunds.ts as an entry to another path, as a symlink
    // does. It stops after some scans, so that a loop fails the test.
    let entryScans = 0;
    const symlink: esbuild.Plugin = {
      name: "symlink",
      setup(build) {
        build.onResolve({ filter: /infra\/refunds\.ts$/ }, (args) => {
          if (args.kind !== "entry-point") return;
          if (++entryScans > 5) {
            return { errors: [{ text: "Scanned the entry too often." }] };
          }
          return { path: path.join(projectRoot, "infra/real/refunds.ts") };
        });
      },
    };
    await expect(
      buildVirtual(files, "infra/main.ts", [
        infraPlugin({
          runtimeModules: ["**/*.fn.ts"],
          getFile: readVirtualFile(files),
          runtimeLink: "@notation/resource",
        }),
        symlink,
      ]),
    ).rejects.toThrow(
      "The compiler scanned infra/refunds.ts as an entry, but the scan's files don't include it.",
    );
    expect(entryScans).toBe(1);
  });

  it("takes any file that infra imports with type: runtime as a runtime module", async () => {
    const files = {
      "infra/main.ts": `
        import { run } from "../runtime/checkout" with { type: "runtime" };
        import "./other";
        console.log(run);
      `,
      "infra/other.ts": ``,
      "runtime/checkout.ts": `
        import { lambda } from "@notation/aws/lambda" with { type: "infra" };
        const { handle } = lambda({ id: "checkout" });
        export const run = handle.apiRequest(() => ({}));
      `,
    };
    const output = await buildInfra(files);
    expect(output).toContain('createStandIn("runtime/checkout.ts", "run")');
    expect(output).toContain('module: "runtime/checkout.ts"');

    await expect(
      buildInfra({
        ...files,
        "infra/other.ts": `import { run } from "../runtime/checkout"; console.log(run);`,
      }),
    ).rejects.toThrow(
      'runtime/checkout.ts is a runtime module, so infra must import it with { type: "runtime" }',
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

  // Bundles `infra/main.ts` of a project that uses `provider`, evaluates it,
  // and prints its `wired` export and the functions in its graph.
  async function evaluateProject(files: Record<string, string>) {
    if (root) rmSync(root, { recursive: true, force: true });
    root = realpathSync(mkdtempSync(path.join(tmpDir, "infra-plugin-")));
    setConfigFile(path.join(root, "notation.config.ts"));
    write("infra/provider.ts", provider);
    for (const [file, contents] of Object.entries(files)) write(file, contents);

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

  const evaluate = () =>
    evaluateProject({
      "infra/main.ts": `
      import * as checkout from "../runtime/checkout.fn" with { type: "runtime" };
      import { route, wired } from "./provider";
      route("/orders", checkout.createOrder);
      route("/refunds", checkout.refund);
      export const memory = 256;
      export { wired };
      `,
      "runtime/checkout.fn.ts": `
      import { fn } from "../infra/provider" with { type: "infra" };
      import { memory } from "../infra/main" with { type: "infra" };
      import { refund } from "./refunds";
      console.log("runtime init");
      const { handle } = fn({ id: "checkout", memory });
      export const createOrder = handle.api(() => { console.log("handler ran"); });
      export { refund };
      `,
      "runtime/refunds.ts": `
      import { handle } from "./fn";
      export const refund = handle.api(() => {});
      `,
      "runtime/fn.ts": `
      import { fn } from "../infra/provider" with { type: "infra" };
      export const { handle } = fn({ id: "refunds", memory: 128 });
      `,
    });

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

  it("gives the same functions and wiring whatever order infra modules load in", async () => {
    // Each runtime module's settings read a value from the infra module that
    // wires the other one.
    const project = (imports: string[]) => ({
      "infra/main.ts": `${imports.map((file) => `import "${file}";`).join("\n")}
      export { wired } from "./provider";`,
      "infra/orders.ts": `
      import { checkout } from "../runtime/checkout.fn" with { type: "runtime" };
      import { route } from "./provider";
      route("/orders", checkout);
      export const memory = 128;
      `,
      "infra/refunds.ts": `
      import { refund } from "../runtime/refund.fn" with { type: "runtime" };
      import { route } from "./provider";
      route("/refunds", refund);
      export const memory = 256;
      `,
      "runtime/checkout.fn.ts": `
      import { fn } from "../infra/provider" with { type: "infra" };
      import { memory } from "../infra/refunds" with { type: "infra" };
      export const checkout = fn({ id: "checkout", memory }).handle.api(() => {});
      `,
      "runtime/refund.fn.ts": `
      import { fn } from "../infra/provider" with { type: "infra" };
      import { memory } from "../infra/orders" with { type: "infra" };
      export const refund = fn({ id: "refund", memory }).handle.api(() => {});
      `,
    });
    const sorted = (output: string) => {
      const { wired, functions } = JSON.parse(output);
      return { wired: [...wired].sort(), functions };
    };

    const first = sorted(
      await evaluateProject(project(["./orders", "./refunds"])),
    );
    const second = sorted(
      await evaluateProject(project(["./refunds", "./orders"])),
    );
    expect(first.wired).toEqual([
      "/orders -> checkout (memory 256)",
      "/refunds -> refund (memory 128)",
    ]);
    expect(second).toEqual(first);
  });
});
