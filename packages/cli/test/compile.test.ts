import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModuleAnalyses } from "@notation/build";
import { setConfigFile, type ModuleGlobs } from "@notation/core";
import { compile, compileInfra, compileRuntimeModules } from "../src/compile";
import type { Logger } from "../src/logger";

// Inside the repository, so the bundle's imports of @notation packages
// resolve from the root node_modules.
const tmpDir = fileURLToPath(new URL("../../../tmp", import.meta.url));

let root: string;
// Directories next to the project root, which each test removes afterwards.
let outside: string[] = [];

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
  for (const dir of outside) rmSync(dir, { recursive: true, force: true });
  outside = [];
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
        "./sns": "./sns.js",
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
  write(
    "node_modules/@notation/aws/sns.js",
    [
      `/** @resource */`,
      `export function topic(config) { return { arn: "placeholder-arn" }; }`,
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
      'The function in runtime/process-orders.ts uses infra/orders.ts, an infra module (files.infra: "infra/**", the default): orders at runtime/process-orders.ts:16:38. It imports infra/orders.ts through runtime/process-orders.ts → infra/orders.ts. The runtime build leaves infra out, so runtime code can\'t use it.',
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
      'The function in runtime/process-orders.ts uses infra/orders.ts, an infra module (files.infra: "infra/**", the default): orders at runtime/queue-url.ts:2:31. It imports infra/orders.ts through runtime/process-orders.ts → runtime/queue-url.ts → infra/orders.ts.',
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
      'uses infra/orders.ts, an infra module (files.infra: "infra/**", the default): orders at runtime/process-orders.ts:16:38.',
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
      "The function in runtime/process-orders.ts uses queue from @notation/aws/sqs.js, a function that declares infrastructure: queue at runtime/process-orders.ts:17:38. It imports @notation/aws/sqs.js through runtime/process-orders.ts → @notation/aws/sqs.js. Infra functions can't run in a runtime module.",
    );
  });

  it("lists only the uses of the resource function that the error names", async () => {
    writeProject(
      handlerModule
        .replace(
          `import { orders } from "../infra/orders";`,
          `import { orders } from "../infra/orders";\n  import { queue } from "@notation/aws/sqs";\n  import { topic } from "@notation/aws/sns";`,
        )
        .replace(
          "export const handler = async () =>",
          "export const handler = async () => topic({ name: 'x' }) && queue({ name: 'x' }) &&",
        ),
    );
    const { modules } = await compileInfra(path.join(root, "infra/orders.ts"));
    await expect(compileRuntimeModules(modules)).rejects.toThrow(
      "a function that declares infrastructure: queue at runtime/process-orders.ts:18:62. It imports",
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
      "The function in runtime/process-orders.ts uses queue from @notation/aws/sqs.js, a function that declares infrastructure. It imports @notation/aws/sqs.js through runtime/process-orders.ts → @notation/aws/helpers.js → @notation/aws/sqs.js. Infra functions can't run in a runtime module.",
    );
  });

  // The infra module calls queue() through a function of its own, so the
  // build doesn't see that it is infra.
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
    },
  );

  // On main, the build didn't see that infra/orders.ts is infra, because it
  // calls queue() through a factory, so the bundle kept queue().
  it("leaves out an infra module that a helper imports for an export the function doesn't use", async () => {
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
    await compileRuntimeModules(modules);
    const bundle = readFileSync(
      path.join(root, "dist/runtime/process-orders/index.mjs"),
      "utf8",
    );
    expect(bundle).toContain(`label = () => "orders"`);
    expect(bundle).not.toContain("makeQueue");
    expect(bundle).not.toContain("placeholder-url");
  });

  it("names the import chain when a module that the function imports brings in a resource function", async () => {
    writeProject(
      handlerModule
        .replace(
          `import { Order } from "./schema";`,
          `import { Order } from "./schema";\n  import { label } from "../lib/labels";`,
        )
        .replace(
          "export const handler = async () =>",
          "export const handler = async () => label() &&",
        ),
    );
    write(
      "lib/labels.ts",
      [
        `import { queue } from "@notation/aws/sqs";`,
        `export const dlq = queue({ name: "dlq" });`,
        `export const label = () => "orders";`,
      ].join("\n"),
    );
    const { modules } = await compileInfra(path.join(root, "infra/orders.ts"));
    await expect(compileRuntimeModules(modules)).rejects.toThrow(
      "The function in runtime/process-orders.ts uses queue from @notation/aws/sqs.js, a function that declares infrastructure: queue at lib/labels.ts:2:20. It imports @notation/aws/sqs.js through runtime/process-orders.ts → lib/labels.ts → @notation/aws/sqs.js. Infra functions can't run in a runtime module.",
    );
  });

  // The bundle check reads the code before minify. Rolldown's default
  // "dce-only" minify drops each of these unused calls, and the build still
  // fails.
  it("fails when the function's only use of an infra module is a call with an unused result", async () => {
    writeProject(
      handlerModule
        .replace(
          `import { Order } from "./schema";`,
          `import { Order } from "./schema";\n  import { queueConfig } from "../infra/names";`,
        )
        .replace(
          "export const handler = async () => [lambda.options",
          `export const handler = async () => { queueConfig("scratch"); return [lambda.options`,
        )
        .replace("globalThis.polyfilled];", "globalThis.polyfilled]; };"),
    );
    write(
      "infra/names.ts",
      [
        `import { queue } from "@notation/aws/sqs";`,
        `export const audit = queue({ name: "audit" });`,
        `export function queueConfig(name: string) { return { name, retries: 3 }; }`,
      ].join("\n"),
    );
    const { modules } = await compileInfra(path.join(root, "infra/orders.ts"));
    await expect(compileRuntimeModules(modules)).rejects.toThrow(
      'The function in runtime/process-orders.ts uses infra/names.ts, an infra module (files.infra: "infra/**", the default): queueConfig at runtime/process-orders.ts:17:40. It imports infra/names.ts through runtime/process-orders.ts → infra/names.ts.',
    );
  });

  it("fails when the function's only use of a resource function is a call with an unused result", async () => {
    writeProject(
      handlerModule
        .replace(
          `import { orders } from "../infra/orders";`,
          `import { orders } from "../infra/orders";\n  import { queue } from "@notation/aws/sqs";`,
        )
        .replace(
          "export const handler = async () => [",
          `export const handler = async () => [queue({ name: "scratch" })] && [`,
        ),
    );
    const { modules } = await compileInfra(path.join(root, "infra/orders.ts"));
    await expect(compileRuntimeModules(modules)).rejects.toThrow(
      "The function in runtime/process-orders.ts uses queue from @notation/aws/sqs.js, a function that declares infrastructure: queue at runtime/process-orders.ts:17:39.",
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

describe("runtime modules that infra doesn't import", () => {
  const entryPoint = () => path.join(root, "infra/orders.ts");

  const writeUnimported = () => {
    writeProject();
    write(
      "runtime/send-receipts.ts",
      handlerModule.replace(`id: "process-orders"`, `id: "send-receipts"`),
    );
  };

  it("adds a declaration module that infra doesn't import", async () => {
    writeUnimported();
    const { modules } = await compileInfra(entryPoint());
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
    await compileInfra(entryPoint());

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
    await compileInfra(entryPoint());
    const bundle = readFileSync(
      path.join(root, "dist/infra/orders.mjs"),
      "utf8",
    );
    expect(bundle).not.toContain("setup ran");
  });

  it("bundles the runtime code of a declaration module that infra doesn't import", async () => {
    writeUnimported();
    await compile(
      { entryPoint: entryPoint(), files: {} },
      { logger: { info: () => {}, error: vi.fn() } as unknown as Logger },
    );
    expect(
      existsSync(path.join(root, "dist/runtime/send-receipts/index.mjs")),
    ).toBe(true);
  });

  it("fails when a runtime file can't be analysed", async () => {
    writeProject();
    write("runtime/broken.ts", `export const broken = ;`);
    await expect(compileInfra(entryPoint())).rejects.toThrow(
      `runtime/broken.ts matches files.runtime, but it can't be analysed: ${path.join(root, "runtime/broken.ts")}: Unexpected token`,
    );
  });
});

// Builds the project with the given globs, and returns the runtime bundle of
// runtime/process-orders.ts.
async function buildProject(files: ModuleGlobs = {}) {
  const analyses = new ModuleAnalyses({ files });
  const { modules } = await compileInfra(path.join(root, "infra/orders.ts"), {
    analyses,
  });
  await compileRuntimeModules(modules, { analyses });
  return {
    modules,
    bundle: readFileSync(
      path.join(root, "dist/runtime/process-orders/index.mjs"),
      "utf8",
    ),
  };
}

// Runs the handler of runtime/process-orders.ts and returns what it returns.
function runHandler() {
  const file = path.join(root, "dist/runtime/process-orders/index.mjs");
  const script = `
    const { handler } = await import(${JSON.stringify(pathToFileURL(file).href)});
    console.log(JSON.stringify(await handler()));
  `;
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: root, encoding: "utf8" },
  );
  return JSON.parse(output.trim().split("\n").at(-1)!);
}

const withHandler = (imports: string, body: string) =>
  handlerModule
    .replace(
      `import { Order } from "./schema";`,
      `import { Order } from "./schema";\n  ${imports}`,
    )
    .replace(
      /export const handler = async \(\) => .*;/,
      `export const handler = async () => ${body};`,
    );

describe("modules that the runtime bundle keeps or leaves out", () => {
  it("runs the top-level code of a setup module that imports infra for a function the bundle doesn't use", async () => {
    writeProject(withHandler(`import "../lib/setup";`, "globalThis.setupRan"));
    write(
      "lib/setup.ts",
      [
        `import { orders } from "../infra/orders";`,
        `globalThis.setupRan = "yes";`,
        `export const url = () => orders.url;`,
      ].join("\n"),
    );
    const { bundle } = await buildProject();
    expect(bundle).not.toContain("placeholder-url");
    expect(runHandler()).toBe("yes");
  });

  it("bundles the other exports of a helper that imports infra for one function", async () => {
    writeProject(
      withHandler(`import { format } from "../lib/format";`, "format()"),
    );
    write(
      "lib/format.ts",
      [
        `import { orders } from "../infra/orders";`,
        `export const format = () => "formatted";`,
        `export const url = () => orders.url;`,
      ].join("\n"),
    );
    const { bundle } = await buildProject();
    expect(bundle).not.toContain("placeholder-url");
    expect(runHandler()).toBe("formatted");
  });

  it("bundles a value from a barrel that also re-exports infra", async () => {
    writeProject(withHandler(`import { format } from "../lib";`, "format()"));
    write(
      "lib/index.ts",
      [
        `export { orders } from "../infra/orders";`,
        `export * from "./format";`,
      ].join("\n"),
    );
    write("lib/format.ts", `export const format = () => "formatted";`);
    const { bundle } = await buildProject();
    expect(bundle).not.toContain("placeholder-url");
    expect(runHandler()).toBe("formatted");
  });

  it("leaves out each module that files.infra matches, even one that calls no resource function", async () => {
    writeProject(
      withHandler(`import { label } from "../infra/labels";`, "label()"),
    );
    write(
      "infra/labels.ts",
      `console.log("labels loaded");\nexport const label = () => "orders";`,
    );
    await expect(buildProject()).rejects.toThrow(
      "The function in runtime/process-orders.ts uses infra/labels.ts, an infra module (files.infra: \"infra/**\", the default): label at runtime/process-orders.ts:17:38. It imports infra/labels.ts through runtime/process-orders.ts → infra/labels.ts. The runtime build leaves infra out, so runtime code can't use it. Read infra values through the declaration's env(). Move a plain value that the function needs, such as a constant, to a shared module (files.shared).",
    );
  });

  it("fails when a module in the bundle imports an infra module for its side effects", async () => {
    writeProject(
      withHandler(`import "../infra/setup";`, "globalThis.setupRan"),
    );
    write("infra/setup.ts", `globalThis.setupRan = "yes";`);
    await expect(buildProject()).rejects.toThrow(
      'runtime/process-orders.ts:6:3: runtime/process-orders.ts imports infra/setup.ts, an infra module (files.infra: "infra/**", the default), for its side effects. The runtime build leaves infra modules out, so the import does nothing in the function. Move the code that the function needs to a shared module (files.shared), or remove the import.',
    );
  });

  it("keeps the top-level code of a module that no glob matches, so a resource call there fails the bundle", async () => {
    writeProject(
      withHandler(`import { label } from "../lib/labels";`, "label()"),
    );
    write(
      "lib/labels.ts",
      [
        `import { queue } from "@notation/aws/sqs";`,
        `export const dlq = queue({ name: "dlq" });`,
        `export const label = () => "orders";`,
      ].join("\n"),
    );
    await expect(buildProject()).rejects.toThrow(
      "uses queue from @notation/aws/sqs.js, a function that declares infrastructure: queue at lib/labels.ts:2:20. It imports @notation/aws/sqs.js through runtime/process-orders.ts → lib/labels.ts → @notation/aws/sqs.js. Infra functions can't run in a runtime module. lib/labels.ts calls queue at its top level, but files.infra doesn't match it. Add lib/labels.ts to files.infra to leave it out of the function.",
    );
  });

  it("names the line of a kept option that refers to a file that no glob matches and that calls a resource function", async () => {
    writeProject(
      handlerModule
        .replace(
          `import { Order } from "./schema";`,
          `import { Order } from "./schema";\n  import { dlq } from "../lib/queues";`,
        )
        .replace("event: () => sqs(Order)", "event: () => sqs(dlq)"),
    );
    write(
      "lib/queues.ts",
      `import { queue } from "@notation/aws/sqs";\nexport const dlq = queue({ name: "dlq" });`,
    );
    await expect(buildProject()).rejects.toThrow(
      "runtime/process-orders.ts:12:22: an option of $lambda that the function keeps refers to dlq, from lib/queues.ts. lib/queues.ts calls queue at its top level, but files.infra doesn't match it. Add lib/queues.ts to files.infra to leave it out of the function. The runtime build removes infra. Read infra values in the function through the declaration's env().",
    );
  });

  it("fails when a kept option refers to an infra module, and says why it is infra", async () => {
    writeProject(
      handlerModule.replace(
        "event: () => sqs(Order)",
        "event: () => sqs(orders)",
      ),
    );
    await expect(buildProject()).rejects.toThrow(
      'an option of $lambda that the function keeps refers to orders, from infra/orders.ts, an infra module (files.infra: "infra/**", the default).',
    );
  });
});

describe("workspace packages outside the project root", () => {
  // A package outside the root, linked into the project's node_modules as a
  // workspace package is. It resolves @notation/aws from the project.
  const writePackage = (name: string, files: Record<string, string>) => {
    const dir = realpathSync(mkdtempSync(path.join(tmpDir, `${name}-`)));
    outside.push(dir);
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, type: "module", main: "./index.ts" }),
    );
    for (const [file, contents] of Object.entries(files)) {
      writeFileSync(path.join(dir, file), contents);
    }
    mkdirSync(path.join(dir, "node_modules/@notation"), { recursive: true });
    symlinkSync(
      path.join(root, "node_modules/@notation/aws"),
      path.join(dir, "node_modules/@notation/aws"),
    );
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(dir, path.join(root, "node_modules", name));
    return dir;
  };

  const acmeLib = {
    "index.ts": `export * from "./queues";\nexport * from "./fmt";`,
    "queues.ts": `import { queue } from "@notation/aws/sqs";\nexport const dlq = queue({ name: "dlq" });`,
    "fmt.ts": `export const fmt = () => "formatted";`,
  };

  it("leaves out a package module that calls a resource function at its top level", async () => {
    writeProject(withHandler(`import { fmt } from "acme-lib";`, "fmt()"));
    writePackage("acme-lib", acmeLib);
    const { bundle } = await buildProject();
    expect(bundle).not.toContain(`"dlq"`);
    expect(runHandler()).toBe("formatted");
  });

  it("fails when the function uses a package module that calls a resource function, and says why it is infra", async () => {
    writeProject(withHandler(`import { dlq } from "acme-lib";`, "dlq"));
    writePackage("acme-lib", acmeLib);
    await expect(buildProject()).rejects.toThrow(
      "uses acme-lib/queues.ts, an infra module (it calls queue at its top level).",
    );
  });

  it("finds and strips a declaration module in a package that infra imports by path", async () => {
    writeProject();
    const dir = writePackage("acme-fns", {
      "fn.ts": handlerModule
        .replace(`id: "process-orders"`, `id: "acme-fn"`)
        .replace(`import "./polyfill";`, "")
        .replace(
          `"../infra/orders"`,
          JSON.stringify(path.join(root, "infra/orders.ts")),
        )
        .replace(
          `"./schema"`,
          JSON.stringify(path.join(root, "runtime/schema.ts")),
        )
        .replace("handler module loaded", "acme fn loaded"),
    });
    write(
      "infra/fns.ts",
      `import { lambda } from ${JSON.stringify(path.join(dir, "fn.ts"))};\nconsole.log(lambda);`,
    );
    const { modules } = await compileInfra(path.join(root, "infra/fns.ts"));
    expect(modules.map((module) => module.path)).toContain(
      path.join(dir, "fn.ts"),
    );
    expect(
      readFileSync(path.join(root, "dist/infra/fns.mjs"), "utf8"),
    ).not.toContain("acme fn loaded");
  });

  it("lets a shared module import a package module that calls a resource function", async () => {
    writeProject(
      withHandler(`import { label } from "../shared/labels";`, "label()"),
    );
    writePackage("acme-lib", acmeLib);
    write(
      "shared/labels.ts",
      `import { fmt } from "acme-lib";\nexport const label = () => fmt();`,
    );
    await buildProject();
    expect(runHandler()).toBe("formatted");
  });
});

describe("a monorepo with the config at its root", () => {
  const writeApi = () => {
    writeProject();
    write("packages/api/package.json", JSON.stringify({ name: "@acme/api" }));
    write(
      "packages/api/handler.ts",
      handlerModule
        .replace(`id: "process-orders"`, `id: "api"`)
        .replace(`import "./polyfill";`, "")
        .replace(`"../infra/orders"`, `"../../infra/orders"`)
        .replace(`"./schema"`, `"../../runtime/schema"`)
        .replace("handler module loaded", "api module loaded"),
    );
    write(
      "infra/api.ts",
      `import "./orders";\nimport { lambda } from "../packages/api/handler";\nconsole.log(lambda);`,
    );
  };

  it("finds and strips a declaration module in a folder with its own package.json", async () => {
    writeApi();
    const { modules } = await compileInfra(path.join(root, "infra/api.ts"));
    expect(modules.map((module) => toRoot(module.path))).toEqual([
      "packages/api/handler.ts",
      "runtime/process-orders.ts",
    ]);
    expect(
      readFileSync(path.join(root, "dist/infra/api.mjs"), "utf8"),
    ).not.toContain("api module loaded");
    await compileRuntimeModules(modules);
    expect(
      readFileSync(
        path.join(root, "dist/packages/api/handler/index.mjs"),
        "utf8",
      ),
    ).toContain("api module loaded");
  });

  it("finds a runtime module in a package folder that files.runtime matches", async () => {
    writeApi();
    write(
      "packages/api/runtime/jobs.ts",
      handlerModule
        .replace(`id: "process-orders"`, `id: "jobs"`)
        .replace(`import "./polyfill";`, "")
        .replace(`"../infra/orders"`, `"../../../infra/orders"`)
        .replace(`"./schema"`, `"../../../runtime/schema"`),
    );
    const { modules } = await compileInfra(path.join(root, "infra/orders.ts"), {
      analyses: new ModuleAnalyses({
        files: { runtime: ["runtime/**", "packages/*/runtime/**"] },
      }),
    });
    expect(modules.map((module) => toRoot(module.path))).toEqual([
      "packages/api/runtime/jobs.ts",
      "runtime/process-orders.ts",
    ]);
  });

  it("leaves out a module of a package folder that calls a resource function at its top level", async () => {
    writeProject(
      withHandler(`import { label } from "../packages/api";`, "label()"),
    );
    write("packages/api/package.json", JSON.stringify({ name: "@acme/api" }));
    write(
      "packages/api/index.ts",
      `export * from "./queues";\nexport const label = () => "orders";`,
    );
    write(
      "packages/api/queues.ts",
      `import { queue } from "@notation/aws/sqs";\nexport const dlq = queue({ name: "dlq" });`,
    );
    const { bundle } = await buildProject();
    expect(bundle).not.toContain(`"dlq"`);
    expect(runHandler()).toBe("orders");
  });
});

describe("files config", () => {
  it("fails for a file that two kinds match, even if nothing imports it", async () => {
    writeProject();
    write("lib/unused.ts", `export const x = 1;`);
    await expect(
      buildProject({ infra: ["infra/**"], shared: ["lib/**", "infra/**"] }),
    ).rejects.toThrow(
      'infra/orders.ts matches both files.infra and files.shared (files.infra: "infra/**"; files.shared: "infra/**").',
    );
  });

  it("says which glob is a default when two kinds match a file", async () => {
    writeProject();
    await expect(buildProject({ infra: ["**/*.ts"] })).rejects.toThrow(
      'runtime/polyfill.ts matches both files.infra and files.runtime (files.infra: "**/*.ts"; files.runtime: "runtime/**", the default).',
    );
  });

  it("fails for a declaration in an infra module", async () => {
    writeProject();
    write(
      "infra/fn.ts",
      `import { $lambda } from "@notation/aws/lambda";\nexport const lambda = $lambda({ id: "fn" });\nexport const handler = () => 1;`,
    );
    write("infra/main.ts", `import "./orders";\nimport "./fn";`);
    await expect(
      compileInfra(path.join(root, "infra/main.ts")),
    ).rejects.toThrow(
      'infra/fn.ts:2:23: infra/fn.ts, an infra module (files.infra: "infra/**", the default), declares a function with $lambda. The runtime build leaves infra modules out, so it can\'t bundle the function. Move the declaration to a runtime module.',
    );
  });

  it.each([["infra"], ["infra/"]])(
    "reads %j in files.infra as the files in the folder",
    async (glob) => {
      writeProject(
        withHandler(`import { label } from "../infra/labels";`, "label()"),
      );
      write("infra/labels.ts", `export const label = () => "orders";`);
      await expect(buildProject({ infra: [glob] })).rejects.toThrow(
        'uses infra/labels.ts, an infra module (files.infra: "infra/**")',
      );
    },
  );

  it("leaves out of the runtime scan the files that a glob with ! in files.runtime matches", async () => {
    writeProject();
    write(
      "runtime/draft.ts",
      handlerModule.replace(`id: "process-orders"`, `id: "draft"`),
    );
    const { modules } = await buildProject({
      runtime: ["runtime/**", "!runtime/draft.ts"],
    });
    expect(modules.map((module) => toRoot(module.path))).toEqual([
      "runtime/process-orders.ts",
    ]);
  });

  it("deploys a declaration module that no glob matches when infra imports it", async () => {
    writeProject();
    write(
      "functions/fn.ts",
      `import { $lambda } from "@notation/aws/lambda";\nexport const lambda = $lambda({ id: "fn" });\nexport const handler = () => 1;`,
    );
    write("infra/main.ts", `import "./orders";\nimport "../functions/fn";`);
    const { modules } = await compileInfra(path.join(root, "infra/main.ts"));
    expect(modules.map((module) => toRoot(module.path))).toEqual([
      "functions/fn.ts",
      "runtime/process-orders.ts",
    ]);
  });
});

describe("shared modules", () => {
  it("runs a shared module in both builds", async () => {
    writeProject(
      handlerModule.replace(`from "./schema"`, `from "../shared/schema"`),
    );
    write(
      "shared/schema.ts",
      `console.log("schema loaded");\nexport const Order = { name: "Order" };`,
    );
    write(
      "infra/orders.ts",
      [
        `import { queue } from "@notation/aws/sqs";`,
        `import { Order } from "../shared/schema";`,
        `import { lambda } from "../runtime/process-orders";`,
        `export const orders = queue({ name: "orders", schema: Order });`,
        `orders.consume(() => lambda);`,
      ].join("\n"),
    );
    const { bundle } = await buildProject();
    expect(bundle).toContain("schema loaded");
    expect(
      readFileSync(path.join(root, "dist/infra/orders.mjs"), "utf8"),
    ).toContain("schema loaded");
  });

  it("fails the infra build when a shared module imports infra through other modules", async () => {
    writeProject();
    write(
      "shared/schema.ts",
      `import { url } from "../lib/url";\nexport const Order = { url };`,
    );
    write(
      "lib/url.ts",
      `import { orders } from "../infra/orders";\nexport const url = () => orders.url;`,
    );
    write("infra/main.ts", `import "./orders";\nimport "../shared/schema";`);
    await expect(
      compileInfra(path.join(root, "infra/main.ts")),
    ).rejects.toThrow(
      'shared/schema.ts, a shared module (files.shared: "shared/**", the default), imports infra/orders.ts, an infra module (files.infra: "infra/**", the default), through shared/schema.ts:1:1 → lib/url.ts:1:1 → infra/orders.ts.',
    );
  });

  it("fails the runtime build when a shared module that only the function uses imports a runtime module", async () => {
    writeProject(
      withHandler(`import { label } from "../shared/labels";`, "label()"),
    );
    write(
      "shared/labels.ts",
      `import { lambda } from "../runtime/process-orders";\nexport const label = () => lambda.id;`,
    );
    const analyses = new ModuleAnalyses();
    const { modules } = await compileInfra(path.join(root, "infra/orders.ts"), {
      analyses,
    });
    await expect(compileRuntimeModules(modules, { analyses })).rejects.toThrow(
      'shared/labels.ts, a shared module (files.shared: "shared/**", the default), imports runtime/process-orders.ts, a runtime module (files.runtime: "runtime/**", the default), through shared/labels.ts:1:1 → runtime/process-orders.ts.',
    );
  });

  it("fails for a shared module that imports a resource function", async () => {
    writeProject(withHandler(`import { make } from "../shared/make";`, "make"));
    write(
      "shared/make.ts",
      `import { queue } from "@notation/aws/sqs";\nexport const make = () => queue({ name: "x" });`,
    );
    await expect(buildProject()).rejects.toThrow(
      'shared/make.ts:1:10: shared/make.ts, a shared module (files.shared: "shared/**", the default), imports the resource function queue from @notation/aws/sqs.',
    );
  });

  it("fails for a declaration in a shared module", async () => {
    writeProject();
    write(
      "shared/fn.ts",
      `import { $lambda } from "@notation/aws/lambda";\nexport const lambda = $lambda({ id: "fn" });\nexport const handler = () => 1;`,
    );
    write("infra/main.ts", `import "./orders";\nimport "../shared/fn";`);
    await expect(
      compileInfra(path.join(root, "infra/main.ts")),
    ).rejects.toThrow(
      'shared/fn.ts:2:23: shared/fn.ts, a shared module (files.shared: "shared/**", the default), declares a function with $lambda.',
    );
  });
});
