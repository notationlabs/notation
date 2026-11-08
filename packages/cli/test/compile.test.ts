import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModuleAnalyses } from "@notation/build";
import { setConfigFile } from "@notation/core";
import { compile, compileInfra, compileRuntimeModules } from "../src/compile";
import type { Logger } from "../src/logger";

// Inside the repository, so the bundle's imports of @notation packages
// resolve from the root node_modules.
const tmpDir = fileURLToPath(new URL("../../../tmp", import.meta.url));

let root: string;

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
  root = realpathSync(mkdtempSync(path.join(tmpDir, "notation-compile-")));
  mkdirSync(path.join(root, "infra"));
  writeFileSync(path.join(root, "notation.config.ts"), "export default {}");
  setConfigFile(path.join(root, "notation.config.ts"));
});

afterEach(() => {
  setConfigFile(undefined);
  rmSync(root, { recursive: true, force: true });
});

it("reports a declaration error at the line of the user's source", async () => {
  const entryPoint = path.join(root, "infra/main.ts");
  writeFileSync(
    entryPoint,
    [
      `import { fs } from "@notation/std.iac";`,
      ``,
      `type Config = { filePath: string };`,
      `const config = { filePath: 42 } as unknown as Config;`,
      ``,
      `new fs.File("bad-file", { config });`,
      ``,
    ].join("\n"),
  );
  await compileInfra(entryPoint);

  const script = `
    process.setSourceMapsEnabled(true);
    try {
      await import(${JSON.stringify(path.join(root, "dist/infra/main.mjs"))});
    } catch (error) {
      console.log(error.declaredAt);
    }
  `;
  const declaredAt = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: root, encoding: "utf8" },
  ).trim();

  expect(declaredAt).toBe("infra/main.ts:6");
});

const toRoot = (file: string) => path.relative(root, file);

const write = (file: string, contents: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), contents);
};

// Stands in for @notation/aws, with the marks that the builds read. The
// runtime build resolves `./lambda` through the `notation-runtime` condition.
function writeAwsPackage() {
  write(
    "node_modules/@notation/aws/package.json",
    JSON.stringify({
      name: "@notation/aws",
      type: "module",
      exports: {
        "./lambda": {
          "notation-runtime": "./lambda-runtime.js",
          import: "./lambda.js",
        },
        "./sqs": "./sqs.js",
        "./helpers": "./helpers.js",
      },
    }),
  );
  write(
    "node_modules/@notation/aws/lambda.js",
    [
      `/** @declaration shared: id, event, env; keys: env; entry: handler */`,
      `export function $lambda(config) { globalThis.declared = config; (globalThis.ran ??= []).push(config.id); return { infra: true }; }`,
      `/** @runtime schema */`,
      `export function sqs(schema) { return { kind: "sqs", schema }; }`,
    ].join("\n"),
  );
  write(
    "node_modules/@notation/aws/lambda-runtime.js",
    [
      `export function $lambda(config) {`,
      `  return { options: Object.keys(config), env: () => config.env(), event: () => config.event() };`,
      `}`,
      `export function sqs(schema) { return { kind: "sqs", schema }; }`,
    ].join("\n"),
  );
  write(
    "node_modules/@notation/aws/sqs.js",
    [
      `import "./sdk.js";`,
      `/** @resource */`,
      `export function queue(config) { return { url: "placeholder-url", consume: () => {} }; }`,
    ].join("\n"),
  );
  write(
    "node_modules/@notation/aws/helpers.js",
    [
      `import { queue } from "./sqs.js";`,
      `export const ordersQueue = () => queue({ name: "orders" });`,
    ].join("\n"),
  );
  write("node_modules/@notation/aws/sdk.js", `console.log("sdk loaded");`);
}

const handlerModule = `
  import "./polyfill";
  import { $lambda, sqs } from "@notation/aws/lambda";
  import { orders } from "../infra/orders";
  import { Order } from "./schema";

  console.log("handler module loaded");

  export const lambda = $lambda({
    id: "process-orders",
    event: () => sqs(Order),
    policy: () => [orders.url],
    env: () => ({ QUEUE_URL: orders.url }),
  });

  export const handler = async () => [lambda.options, lambda.env(), lambda.event(), globalThis.polyfilled];
`;

function writeProject(handler = handlerModule) {
  writeAwsPackage();
  write(
    "infra/orders.ts",
    [
      `import { queue } from "@notation/aws/sqs";`,
      `import { lambda } from "../runtime/process-orders";`,
      `export const orders = queue({ name: "orders" });`,
      `orders.consume(() => lambda);`,
    ].join("\n"),
  );
  write("runtime/process-orders.ts", handler);
  write("runtime/schema.ts", `export const Order = { name: "Order" };`);
  write("runtime/polyfill.ts", `globalThis.polyfilled = true;`);
}

describe("declaration modules", () => {
  it("returns the declaration modules that the infra entry reaches", async () => {
    writeProject();
    expect(
      (await compileInfra(path.join(root, "infra/orders.ts"))).modules,
    ).toEqual([
      {
        path: path.join(root, "runtime/process-orders.ts"),
        binding: "lambda",
        entry: "handler",
      },
    ]);
  });

  it("runs only the declaration in the infra bundle, and records its module", async () => {
    writeProject();
    await compileInfra(path.join(root, "infra/orders.ts"));

    const bundle = readFileSync(
      path.join(root, "dist/infra/orders.mjs"),
      "utf8",
    );
    expect(bundle).not.toContain("handler module loaded");
    expect(bundle).not.toContain("polyfilled");

    const script = `
      const lambda = (await import("./dist/infra/orders.mjs"), globalThis.declared);
      console.log(JSON.stringify({ id: lambda.id, env: lambda.env() }));
    `;
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({
      id: "process-orders",
      env: { QUEUE_URL: "placeholder-url" },
    });
    expect(bundle).toContain(`"runtime/process-orders.ts", "lambda")`);
    expect(bundle).not.toContain(root);
  });

  it("bundles a declaration module without its infra", async () => {
    writeProject();
    await compileRuntimeModules(
      (await compileInfra(path.join(root, "infra/orders.ts"))).modules,
    );

    const file = path.join(root, "dist/runtime/process-orders/index.mjs");
    const bundle = readFileSync(file, "utf8");
    expect(bundle).not.toContain("placeholder-url");
    expect(bundle).not.toContain("sdk loaded");
    expect(bundle).not.toContain("policy");

    const script = `
      const { handler } = await import(${JSON.stringify(pathToFileURL(file).href)});
      const [options, env, ...rest] = await handler();
      console.log(JSON.stringify([options, Object.entries(env), ...rest]));
    `;
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(output.split("\n")[0]).toBe("handler module loaded");
    expect(JSON.parse(output.split("\n")[1]!)).toEqual([
      ["id", "event", "env"],
      [["QUEUE_URL", null]],
      { kind: "sqs", schema: { name: "Order" } },
      true,
    ]);
  });

  it("fails when the function reads an infra module directly", async () => {
    writeProject(
      handlerModule.replace(
        "export const handler = async () =>",
        "export const handler = async () => orders.url ??",
      ),
    );
    const { modules } = await compileInfra(path.join(root, "infra/orders.ts"));
    await expect(compileRuntimeModules(modules)).rejects.toThrow(
      "The bundle of runtime/process-orders.ts includes the infra module infra/orders.ts. The bundle imports it through runtime/process-orders.ts → infra/orders.ts, and uses orders at runtime/process-orders.ts:16:38.",
    );
  });

  it("names the use of an infra module in a module that the function imports", async () => {
    writeProject(
      handlerModule
        .replace(
          `import { Order } from "./schema";`,
          `import { Order } from "./schema";\n  import { queueUrl } from "./queue-url";`,
        )
        .replace(
          "export const handler = async () =>",
          "export const handler = async () => queueUrl() ??",
        ),
    );
    write(
      "runtime/queue-url.ts",
      [
        `import { orders } from "../infra/orders";`,
        `export const queueUrl = () => orders.url;`,
      ].join("\n"),
    );
    const { modules } = await compileInfra(path.join(root, "infra/orders.ts"));
    await expect(compileRuntimeModules(modules)).rejects.toThrow(
      "The bundle of runtime/process-orders.ts includes the infra module runtime/queue-url.ts. The bundle imports it through runtime/process-orders.ts → runtime/queue-url.ts, and uses queueUrl at runtime/process-orders.ts:17:38. runtime/queue-url.ts is an infra module because it imports infra/orders.ts (runtime/queue-url.ts:1:1), which imports queue from @notation/aws/sqs (infra/orders.ts:1:10).",
    );
  });

  it("names the use of an infra module imported through a tsconfig path", async () => {
    writeProject(
      handlerModule
        .replace(`from "../infra/orders"`, `from "infra/orders"`)
        .replace(
          "export const handler = async () =>",
          "export const handler = async () => orders.url ??",
        ),
    );
    write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { paths: { "infra/*": ["./infra/*"] } },
      }),
    );
    const { modules } = await compileInfra(path.join(root, "infra/orders.ts"));
    await expect(compileRuntimeModules(modules)).rejects.toThrow(
      "and uses orders at runtime/process-orders.ts:16:38.",
    );
  });

  it("fails when the function calls a resource function from a package", async () => {
    writeProject(
      handlerModule
        .replace(
          `import { orders } from "../infra/orders";`,
          `import { orders } from "../infra/orders";\n  import { queue } from "@notation/aws/sqs";`,
        )
        .replace(
          "export const handler = async () =>",
          "export const handler = async () => queue({ name: 'x' }) &&",
        ),
    );
    const { modules } = await compileInfra(path.join(root, "infra/orders.ts"));
    await expect(compileRuntimeModules(modules)).rejects.toThrow(
      "The bundle of runtime/process-orders.ts includes queue from @notation/aws/sqs.js, a function that declares infrastructure. The bundle imports it through runtime/process-orders.ts → @notation/aws/sqs.js, and uses queue at runtime/process-orders.ts:17:38.",
    );
  });

  it("names the import chain by package when a package function declares infra", async () => {
    writeProject(
      handlerModule
        .replace(
          `import { orders } from "../infra/orders";`,
          `import { orders } from "../infra/orders";\n  import { ordersQueue } from "@notation/aws/helpers";`,
        )
        .replace(
          "export const handler = async () =>",
          "export const handler = async () => ordersQueue() &&",
        ),
    );
    const { modules } = await compileInfra(path.join(root, "infra/orders.ts"));
    await expect(compileRuntimeModules(modules)).rejects.toThrow(
      "The bundle imports it through runtime/process-orders.ts → @notation/aws/helpers.js → @notation/aws/sqs.js.",
    );
  });

  // The infra module calls queue() through a factory of its own. The factory
  // calls queue() only inside a function.
  function writeFactoryInfra() {
    write(
      "infra/helpers.ts",
      [
        `import { queue } from "@notation/aws/sqs";`,
        `export function makeQueue(name: string) { return queue({ name }); }`,
      ].join("\n"),
    );
    write(
      "infra/orders.ts",
      [
        `import { makeQueue } from "./helpers";`,
        `import { lambda } from "../runtime/process-orders";`,
        `export const orders = makeQueue("orders");`,
        `orders.consume(() => lambda);`,
      ].join("\n"),
    );
  }

  it.each([false, true])(
    "leaves out an infra module that calls a factory, with verbatimModuleSyntax %s",
    async (verbatimModuleSyntax) => {
      writeProject();
      writeFactoryInfra();
      write(
        "tsconfig.json",
        JSON.stringify({ compilerOptions: { verbatimModuleSyntax } }),
      );
      await compileRuntimeModules(
        (await compileInfra(path.join(root, "infra/orders.ts"))).modules,
      );
      const bundle = readFileSync(
        path.join(root, "dist/runtime/process-orders/index.mjs"),
        "utf8",
      );
      expect(bundle).not.toContain("makeQueue");
      expect(bundle).not.toContain("placeholder-url");
      expect(bundle).not.toContain("sdk loaded");
    },
  );

  it("names the import chain when a module that the function imports brings in infra", async () => {
    writeProject(
      handlerModule
        .replace(
          `import { Order } from "./schema";`,
          `import { Order } from "./schema";\n  import { label } from "./labels";`,
        )
        .replace(
          "export const handler = async () =>",
          "export const handler = async () => label() &&",
        ),
    );
    writeFactoryInfra();
    write(
      "runtime/labels.ts",
      [
        `import { orders } from "../infra/orders";`,
        `export const label = () => "orders";`,
        `export const queueUrl = () => orders.url;`,
      ].join("\n"),
    );
    const { modules } = await compileInfra(path.join(root, "infra/orders.ts"));
    await expect(compileRuntimeModules(modules)).rejects.toThrow(
      "The bundle of runtime/process-orders.ts includes the infra module runtime/labels.ts. The bundle imports it through runtime/process-orders.ts → runtime/labels.ts, and uses label at runtime/process-orders.ts:17:38. runtime/labels.ts is an infra module because it imports infra/orders.ts (runtime/labels.ts:1:1), which imports infra/helpers.ts (infra/orders.ts:1:1), which imports queue from @notation/aws/sqs (infra/helpers.ts:1:10). The runtime build leaves infra modules out, so runtime code can't use them.",
    );
  });

  it("fails when infra imports a name that the declaration doesn't use", async () => {
    writeProject(`${handlerModule}\nexport const ROUTE = "/orders";\n`);
    write(
      "infra/routes.ts",
      [
        `import { ROUTE } from "../runtime/process-orders";`,
        `import "./orders";`,
        `console.log(ROUTE);`,
      ].join("\n"),
    );
    await expect(
      compileInfra(path.join(root, "infra/routes.ts")),
    ).rejects.toThrow(
      "Illegal import: infra/routes.ts imports ROUTE from a runtime module, runtime/process-orders.ts. Move ROUTE to a shared module.",
    );
  });

  it("lets infra import a name that the declaration uses", async () => {
    writeProject(
      handlerModule
        .replace("QUEUE_URL: orders.url", "QUEUE_URL: orders.url, NAME")
        .replace(
          "export const lambda",
          `export const NAME = "orders";\nexport const lambda`,
        ),
    );
    write(
      "infra/names.ts",
      [
        `import { NAME } from "../runtime/process-orders";`,
        `import "./orders";`,
        `console.log(NAME);`,
      ].join("\n"),
    );
    await compileInfra(path.join(root, "infra/names.ts"));
  });

  it("fails when a declaration module doesn't export handler", async () => {
    writeProject(
      handlerModule.replace("export const handler", "const handler"),
    );
    await expect(
      compileInfra(path.join(root, "infra/orders.ts")),
    ).rejects.toThrow(
      "runtime/process-orders.ts: the module declares a function with $lambda, so it must export `handler`",
    );
  });
});

describe("runtime modules in a named package under the project root", () => {
  const writeMonorepo = () => {
    writeProject();
    write("package.json", JSON.stringify({ name: "monorepo" }));
    write("packages/api/package.json", JSON.stringify({ name: "@acme/api" }));
    write(
      "packages/api/handler.ts",
      handlerModule
        .replace(`"./polyfill"`, `"../../runtime/polyfill"`)
        .replace(`"../infra/orders"`, `"../../infra/orders"`)
        .replace(`"./schema"`, `"../../runtime/schema"`)
        .replace(`id: "process-orders"`, `id: "api"`),
    );
  };

  it("finds and strips a declaration module that infra imports", async () => {
    writeMonorepo();
    write(
      "infra/orders.ts",
      [
        `import { queue } from "@notation/aws/sqs";`,
        `import { lambda } from "../runtime/process-orders";`,
        `import { lambda as api } from "../packages/api/handler";`,
        `export const orders = queue({ name: "orders" });`,
        `orders.consume(() => [lambda, api]);`,
      ].join("\n"),
    );
    const { modules } = await compileInfra(path.join(root, "infra/orders.ts"));
    expect(modules.map((module) => toRoot(module.path))).toEqual([
      "packages/api/handler.ts",
      "runtime/process-orders.ts",
    ]);
    const bundle = readFileSync(
      path.join(root, "dist/infra/orders.mjs"),
      "utf8",
    );
    expect(bundle).not.toContain("handler module loaded");
  });

  it("finds a declaration module through runtimeModules", async () => {
    writeMonorepo();
    const { modules } = await compileInfra(path.join(root, "infra/orders.ts"), {
      runtimeModules: ["packages/*/handler.ts"],
    });
    expect(modules.map((module) => toRoot(module.path))).toEqual([
      "packages/api/handler.ts",
      "runtime/process-orders.ts",
    ]);
  });
});

describe("runtime modules that infra doesn't import", () => {
  const entryPoint = () => path.join(root, "infra/orders.ts");
  const runtimeModules = ["runtime/**/*.ts"];

  const writeUnimported = () => {
    writeProject();
    write(
      "runtime/send-receipts.ts",
      handlerModule.replace(`id: "process-orders"`, `id: "send-receipts"`),
    );
  };

  it("adds a declaration module that infra doesn't import", async () => {
    writeUnimported();
    const { modules } = await compileInfra(entryPoint(), { runtimeModules });
    expect(modules.map((module) => toRoot(module.path))).toEqual([
      "runtime/process-orders.ts",
      "runtime/send-receipts.ts",
    ]);
  });

  it("runs the infra entry before the declaration modules that it doesn't import", async () => {
    writeUnimported();
    write(
      "infra/orders.ts",
      [
        `import { queue } from "@notation/aws/sqs";`,
        `import { lambda } from "../runtime/process-orders";`,
        `export const orders = queue({ name: "orders" });`,
        `orders.consume(() => lambda);`,
        `(globalThis.ran ??= []).push("entry");`,
      ].join("\n"),
    );
    await compileInfra(entryPoint(), { runtimeModules });

    const script = `
      await import("./dist/infra/orders.mjs");
      console.log(JSON.stringify(globalThis.ran));
    `;
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: root, encoding: "utf8" },
    );
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual([
      "process-orders",
      "entry",
      "send-receipts",
    ]);
  });

  it("doesn't import a runtime file without a declaration", async () => {
    writeProject();
    write("runtime/setup.ts", `console.log("setup ran");`);
    await compileInfra(entryPoint(), { runtimeModules });
    const bundle = readFileSync(
      path.join(root, "dist/infra/orders.mjs"),
      "utf8",
    );
    expect(bundle).not.toContain("setup ran");
  });

  it("bundles the runtime code of a declaration module that infra doesn't import", async () => {
    writeUnimported();
    await compile(
      { entryPoint: entryPoint(), runtimeModules },
      { logger: { info: () => {}, error: vi.fn() } as unknown as Logger },
    );
    expect(
      existsSync(path.join(root, "dist/runtime/send-receipts/index.mjs")),
    ).toBe(true);
  });

  it("fails when a runtime file can't be analysed", async () => {
    writeProject();
    write("runtime/broken.ts", `export const broken = ;`);
    await expect(
      compileInfra(entryPoint(), { runtimeModules }),
    ).rejects.toThrow(
      `runtime/broken.ts matches runtimeModules, but it can't be analysed: ${path.join(root, "runtime/broken.ts")}: Unexpected token`,
    );
  });
});

describe("shared modules", () => {
  const entryPoint = () => path.join(root, "infra/orders.ts");
  const bundleFile = () =>
    path.join(root, "dist/runtime/process-orders/index.mjs");

  const build = async (sharedModules: string[] = []) => {
    const analyses = new ModuleAnalyses({ sharedModules });
    const { modules } = await compileInfra(entryPoint(), { analyses });
    await compileRuntimeModules(modules, { analyses });
  };

  // A shared module with an effect that records each build that runs it.
  const writeShared = () => {
    write(
      "shared/schema.ts",
      [
        `(globalThis.sharedRan ??= []).push("schema");`,
        `export const Order = { name: "Order" };`,
      ].join("\n"),
    );
  };

  const runBundle = (file: string, call: string) =>
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); ${call}`,
      ],
      { cwd: root, encoding: "utf8" },
    );

  it("bundles a shared module as written in both builds", async () => {
    writeProject(
      handlerModule.replace(`from "./schema"`, `from "../shared/schema"`),
    );
    writeShared();
    write(
      "infra/orders.ts",
      [
        `import { queue } from "@notation/aws/sqs";`,
        `import { Order } from "../shared/schema";`,
        `import { lambda } from "../runtime/process-orders";`,
        `export const orders = queue({ name: Order.name });`,
        `orders.consume(() => lambda);`,
      ].join("\n"),
    );
    await build(["shared/**"]);

    const infraOutput = runBundle(
      path.join(root, "dist/infra/orders.mjs"),
      "console.log(JSON.stringify(globalThis.sharedRan));",
    );
    expect(JSON.parse(infraOutput.trim().split("\n").at(-1)!)).toEqual([
      "schema",
    ]);

    const runtimeOutput = runBundle(
      bundleFile(),
      "const [, , event] = await m.handler(); console.log(JSON.stringify([globalThis.sharedRan, event]));",
    );
    expect(JSON.parse(runtimeOutput.trim().split("\n").at(-1)!)).toEqual([
      ["schema"],
      { kind: "sqs", schema: { name: "Order" } },
    ]);
  });

  it("leaves out a barrel that re-exports infra", async () => {
    writeProject(
      handlerModule.replace(`from "../infra/orders"`, `from "../infra"`),
    );
    write("infra/index.ts", `export * from "./orders";`);
    await build();
    const bundle = readFileSync(bundleFile(), "utf8");
    expect(bundle).not.toContain("placeholder-url");
    expect(bundle).not.toContain("infra/index.ts");
  });

  it("names the chain through a barrel when a kept option refers to it", async () => {
    writeProject(
      handlerModule
        .replace(`from "../infra/orders"`, `from "../infra"`)
        .replace("sqs(Order)", "sqs(orders)"),
    );
    write("infra/index.ts", `export * from "./orders";`);
    await expect(build()).rejects.toThrow(
      "runtime/process-orders.ts:11:22: an option of $lambda that the function keeps refers to orders, from infra/index.ts, which is an infra module because it imports infra/orders.ts (infra/index.ts:1:1), which imports queue from @notation/aws/sqs (infra/orders.ts:1:10). The runtime build removes infra.",
    );
  });

  it("leaves out an unlisted module that imports infra, when the function doesn't use its import", async () => {
    writeProject(
      handlerModule.replace(
        `import { Order } from "./schema";`,
        `import { Order } from "./schema";\n  import { format } from "../shared/format";`,
      ),
    );
    write(
      "shared/format.ts",
      [
        `import { orders } from "../infra/orders";`,
        `export const format = () => orders.url;`,
      ].join("\n"),
    );
    await build();
    const bundle = readFileSync(bundleFile(), "utf8");
    expect(bundle).not.toContain("format = ");
    expect(bundle).not.toContain("sdk loaded");
  });

  it("fails when the function imports an unlisted module that imports infra for its side effects", async () => {
    writeProject(
      handlerModule.replace(
        `import { Order } from "./schema";`,
        `import { Order } from "./schema";\n  import "../lib/setup";`,
      ),
    );
    write(
      "lib/setup.ts",
      [
        `import { orders } from "../infra/orders";`,
        `globalThis.setupRan = "yes";`,
        `export const url = () => orders.url;`,
      ].join("\n"),
    );
    await expect(build()).rejects.toThrow(
      "runtime/process-orders.ts:6:3: runtime/process-orders.ts imports lib/setup.ts for its side effects, but lib/setup.ts is an infra module because it imports infra/orders.ts (lib/setup.ts:1:1), which imports queue from @notation/aws/sqs (infra/orders.ts:1:10). The runtime build leaves infra modules out, so lib/setup.ts doesn't run in the function.",
    );
  });

  it("bundles a helper that imports infra only for types", async () => {
    writeProject(
      handlerModule
        .replace(
          `import { Order } from "./schema";`,
          `import { Order } from "./schema";\n  import { format } from "../lib/format";`,
        )
        .replace(
          "export const handler = async () =>",
          "export const handler = async () => format() &&",
        ),
    );
    write(
      "lib/format.ts",
      [
        `import { orders } from "../infra/orders";`,
        `export type Queue = typeof orders;`,
        `export const format = (queue?: Queue) => "formatted";`,
      ].join("\n"),
    );
    await build();
    const bundle = readFileSync(bundleFile(), "utf8");
    expect(bundle).toContain("formatted");
    expect(bundle).not.toContain("placeholder-url");
  });

  it("advises moving a plain value out of a module that is infra through its imports", async () => {
    writeProject(
      handlerModule.replace(`from "./schema"`, `from "../shared/schema"`),
    );
    write(
      "shared/schema.ts",
      [
        `import { orders } from "../infra/orders";`,
        `export const Order = { name: "Order" };`,
        `export const url = () => orders.url;`,
      ].join("\n"),
    );
    await expect(build()).rejects.toThrow(
      "runtime/process-orders.ts:11:22: an option of $lambda that the function keeps refers to Order, from shared/schema.ts, which is an infra module because it imports infra/orders.ts (shared/schema.ts:1:1), which imports queue from @notation/aws/sqs (infra/orders.ts:1:10). Move Order to a module that doesn't import infra, or remove the import that makes shared/schema.ts infra.",
    );
  });

  it("names a dynamic import in the chain", async () => {
    writeProject(
      handlerModule.replace(
        "export const handler = async () =>",
        `export const handler = async () => (await import("../lib/lazy")).url() &&`,
      ),
    );
    write(
      "lib/lazy.ts",
      [
        `import { orders } from "../infra/orders";`,
        `export const url = () => orders.url;`,
      ].join("\n"),
    );
    await expect(build()).rejects.toThrow(
      "The bundle of runtime/process-orders.ts includes the infra module lib/lazy.ts. The bundle imports it through runtime/process-orders.ts → lib/lazy.ts.",
    );
  });

  it("fails when the function uses an unlisted module that imports infra", async () => {
    writeProject(
      handlerModule
        .replace(
          `import { Order } from "./schema";`,
          `import { Order } from "./schema";\n  import { format } from "../shared/format";`,
        )
        .replace(
          "export const handler = async () =>",
          "export const handler = async () => format() &&",
        ),
    );
    write(
      "shared/format.ts",
      [
        `import { orders } from "../infra/orders";`,
        `export const format = () => "orders";`,
        `export const url = () => orders.url;`,
      ].join("\n"),
    );
    await expect(build()).rejects.toThrow(
      "The bundle of runtime/process-orders.ts includes the infra module shared/format.ts. The bundle imports it through runtime/process-orders.ts → shared/format.ts, and uses format at runtime/process-orders.ts:17:38. shared/format.ts is an infra module because it imports infra/orders.ts (shared/format.ts:1:1), which imports queue from @notation/aws/sqs (infra/orders.ts:1:10).",
    );
  });

  it("fails when a listed shared module imports infra", async () => {
    writeProject(
      handlerModule.replace(
        `import { Order } from "./schema";`,
        `import { Order } from "../shared/format";`,
      ),
    );
    write(
      "shared/format.ts",
      [
        `export const Order = { name: "Order" };`,
        `import { orders } from "../infra/orders";`,
        `export const url = () => orders.url;`,
      ].join("\n"),
    );
    await expect(build(["shared/**"])).rejects.toThrow(
      "shared/format.ts:2:1: shared/format.ts matches sharedModules, but it imports infra/orders.ts, which is an infra module because it imports queue from @notation/aws/sqs (infra/orders.ts:1:10). A shared module runs in both builds, so it can't declare a function or resources, or import an infra or runtime module.",
    );
  });

  it("fails when a listed shared module imports a runtime module", async () => {
    writeProject();
    write(
      "shared/route.ts",
      [
        `import { lambda } from "../runtime/process-orders";`,
        `export const route = () => lambda;`,
      ].join("\n"),
    );
    write(
      "infra/main.ts",
      [
        `import "./orders";`,
        `import { route } from "../shared/route";`,
        `route();`,
      ].join("\n"),
    );
    await expect(
      compileInfra(path.join(root, "infra/main.ts"), {
        analyses: new ModuleAnalyses({ sharedModules: ["shared/*.ts"] }),
      }),
    ).rejects.toThrow(
      "shared/route.ts:1:1: shared/route.ts matches sharedModules, but it imports runtime/process-orders.ts, which is a runtime module because it declares a function with $lambda.",
    );
  });

  it("fails when a listed shared module imports a resource function", async () => {
    writeProject();
    write(
      "infra/orders.ts",
      [
        `import { queue } from "@notation/aws/sqs";`,
        `import { lambda } from "../runtime/process-orders";`,
        `export const orders = queue({ name: "orders" });`,
        `orders.consume(() => lambda);`,
      ].join("\n"),
    );
    await expect(build(["infra/**"])).rejects.toThrow(
      "infra/orders.ts:1:10: infra/orders.ts matches sharedModules, but it imports the resource function queue from @notation/aws/sqs.",
    );
  });

  it("accepts sharedModules globs with a leading ./", async () => {
    writeProject();
    await expect(build(["./infra/**"])).rejects.toThrow(
      "infra/orders.ts:1:10: infra/orders.ts matches sharedModules, but it imports the resource function queue from @notation/aws/sqs.",
    );
  });

  it("reads sharedModules from the build", async () => {
    writeProject();
    write(
      "runtime/schema.ts",
      `import { orders } from "../infra/orders";\nexport const Order = { name: "Order", queue: () => orders };`,
    );
    await expect(
      compile(
        {
          entryPoint: entryPoint(),
          runtimeModules: [],
          sharedModules: ["runtime/schema.ts"],
        },
        { logger: { info: () => {}, error: vi.fn() } as unknown as Logger },
      ),
    ).rejects.toThrow(
      "runtime/schema.ts:1:1: runtime/schema.ts matches sharedModules, but it imports infra/orders.ts",
    );
  });
});
