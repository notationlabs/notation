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
      "The bundle of runtime/process-orders.ts includes the infra module infra/orders.ts. The bundle imports it through runtime/process-orders.ts → runtime/queue-url.ts → infra/orders.ts, and uses orders at runtime/queue-url.ts:2:31.",
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
      "The bundle of runtime/process-orders.ts includes queue from @notation/aws/sqs.js, a function that declares infrastructure. The bundle imports it through runtime/process-orders.ts → runtime/labels.ts → infra/orders.ts → infra/helpers.ts → @notation/aws/sqs.js, and uses queue at infra/helpers.ts:2:50. Infra functions can't run in a runtime module.",
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
