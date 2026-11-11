import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setConfigFile } from "@notation/core";
import { compileInfra, compileRuntimeModules } from "../src/compile";

// Inside the repository, so the bundle's imports of @notation packages
// resolve from the root node_modules.
const tmpDir = fileURLToPath(new URL("../../../tmp", import.meta.url));

let root: string;

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
  root = realpathSync(mkdtempSync(path.join(tmpDir, "notation-workers-")));
  writeFileSync(path.join(root, "notation.config.ts"), "export default {}");
  setConfigFile(path.join(root, "notation.config.ts"));
});

afterEach(() => {
  setConfigFile(undefined);
  rmSync(root, { recursive: true, force: true });
});

const write = (file: string, contents: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), contents);
};

const read = (file: string) => readFileSync(path.join(root, file), "utf8");

// Stands in for a Cloudflare provider package. The infra side records each
// declaration on globalThis. `worker.check()` does what the provider's plan
// would do with the Worker's exports in its declaredIn record. The runtime
// side, through the notation-runtime condition, has no marks.
function writeCloudflarePackage() {
  write(
    "node_modules/@notation/cloudflare/package.json",
    JSON.stringify({
      name: "@notation/cloudflare",
      type: "module",
      sideEffects: false,
      exports: {
        "./workers": {
          "notation-runtime": "./workers-runtime.js",
          import: "./workers.js",
        },
      },
    }),
  );
  write(
    "node_modules/@notation/cloudflare/workers.js",
    [
      `/** @declaration shared: id; runtime: class */`,
      `export function $durableObject(config) {`,
      `  const namespace = { kind: "INFRA_NAMESPACE", id: config.id, className: config.class.name };`,
      `  (globalThis.namespaces ??= []).push(namespace);`,
      `  return namespace;`,
      `}`,
      `/** @declaration shared: id, bindings; keys: bindings; entry: default; platform: workerd */`,
      `export function $worker(config) {`,
      `  const worker = { kind: "INFRA_WORKER", id: config.id, bindings: config.bindings, check: () => checkExports(worker, config) };`,
      `  (globalThis.workers ??= []).push(worker);`,
      `  return worker;`,
      `}`,
      `function checkExports(worker, config) {`,
      `  const record = worker[Symbol.for("@notation/declaredIn")];`,
      `  return Object.values(config.bindings())`,
      `    .filter((bound) => bound.kind === "INFRA_NAMESPACE" && !record.exports.includes(bound.className))`,
      `    .map((namespace) => {`,
      `      const star = record.starExports.length === 0 ? "" : \` The bundle doesn't re-export the names of \${record.starExports.map((s) => \`export * from \${JSON.stringify(s)}\`).join(", ")}, so export \${namespace.className} by name.\`;`,
      `      return \`\${record.path} doesn't export \${namespace.className}, the class of the Durable Object namespace \${namespace.id}. Cloudflare finds the class by its export name.\${star}\`;`,
      `    });`,
      `}`,
    ].join("\n"),
  );
  write(
    "node_modules/@notation/cloudflare/workers-runtime.js",
    [
      `export function $durableObject(config) { return { id: config.id }; }`,
      `export function $worker(config) { return { id: config.id, bindingNames: Object.keys(config.bindings()) }; }`,
    ].join("\n"),
  );
}

const counterModule = `
import { DurableObject } from "cloudflare:workers";
import { $durableObject } from "@notation/cloudflare/workers";

export class Counter extends DurableObject {
  async fetch() {
    const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return new Response(\`count=\${count}\`);
  }
}

export const counters = $durableObject({ id: "counters", class: Counter });
`;

const reexport = `export { Counter } from "./counter";`;

const apiModule = (classExport: string) => `
import { $worker } from "@notation/cloudflare/workers";
import { counters } from "./counter";
${classExport}

export const worker = $worker({
  id: "api",
  bindings: () => ({ COUNTERS: counters }),
});

export default {
  async fetch(request, env) {
    const stub = env.COUNTERS.get(env.COUNTERS.idFromName("one"));
    const response = await stub.fetch(request);
    return new Response(\`\${worker.id} \${worker.bindingNames.join(",")} \${await response.text()}\`);
  },
};
`;

function writeProject(classExport = reexport) {
  writeCloudflarePackage();
  write("infra/main.ts", `export {};`);
  write("runtime/counter.ts", counterModule);
  write("runtime/api.ts", apiModule(classExport));
}

function runInfra(report: string) {
  const script = `
    await import(${JSON.stringify(pathToFileURL(path.join(root, "dist/infra/main.mjs")).href)});
    const [namespace] = globalThis.namespaces;
    const [worker] = globalThis.workers;
    console.log(JSON.stringify(${report}));
  `;
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: root, encoding: "utf8" },
  );
  return JSON.parse(output);
}

async function build() {
  const { modules } = await compileInfra(path.join(root, "infra/main.ts"));
  await compileRuntimeModules(modules);
  return modules;
}

const apiBundle = "dist/runtime/api/index.mjs";

const recordedExports = () =>
  runInfra(`worker[Symbol.for("@notation/declaredIn")].exports`);

it("records the namespace with no entry, and the worker with its other exports", async () => {
  writeProject();
  expect(await build()).toEqual([
    {
      path: path.join(root, "runtime/api.ts"),
      binding: "worker",
      entry: "default",
      platform: "workerd",
    },
    { path: path.join(root, "runtime/counter.ts"), binding: "counters" },
  ]);
});

it("leaves the class and its import out of the infra bundle, and keeps its name", async () => {
  writeProject();
  await build();

  const infraFiles = readdirSync(path.join(root, "dist"), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".mjs") && !file.startsWith("runtime"));
  for (const file of infraFiles) {
    const code = read(path.join("dist", file));
    expect(code).not.toContain("cloudflare:workers");
    expect(code).not.toContain("DurableObject");
    expect(code).not.toContain("storage");
  }

  expect(
    runInfra(`{
      className: namespace.className,
      bound: worker.bindings().COUNTERS === namespace,
      record: worker[Symbol.for("@notation/declaredIn")],
    }`),
  ).toEqual({
    className: "Counter",
    bound: true,
    record: {
      path: "runtime/api.ts",
      binding: "worker",
      exports: ["Counter"],
      starExports: [],
    },
  });
});

describe("the exports in the worker's declaredIn record", () => {
  const record = () => runInfra(`worker[Symbol.for("@notation/declaredIn")]`);

  it.each([
    ["no export of the class", "", [], []],
    [
      "the class under another name",
      `export { Counter as Foo } from "./counter";`,
      ["Foo"],
      [],
    ],
    ["export *", `export * from "./counter";`, [], ["./counter"]],
    ["a re-export of the class", reexport, ["Counter"], []],
  ])("holds %s", async (_, classExport, exports, starExports) => {
    writeProject(classExport);
    await build();
    expect(record()).toMatchObject({ exports, starExports });
  });

  it("lets a provider name a bound class that the Worker doesn't export", async () => {
    writeProject("");
    await build();
    expect(runInfra("worker.check()")).toEqual([
      "runtime/api.ts doesn't export Counter, the class of the Durable Object namespace counters. Cloudflare finds the class by its export name.",
    ]);
  });
});

it("writes a runtime bundle for the worker only, which exports the class and holds no infra", async () => {
  writeProject();
  await build();

  expect(existsSync(path.join(root, "dist/runtime/counter"))).toBe(false);
  const code = read(apiBundle);
  expect(code).toMatch(/import \{ DurableObject \} from "cloudflare:workers"/);
  expect(code).toMatch(/export \{[^}]*\bCounter\b[^}]*\}/);
  expect(code).toMatch(/export \{[^}]*\bas default\b[^}]*\}/);
  expect(code).not.toContain("INFRA_");
  expect(code).not.toMatch(/export \{[^}]*\bworker\b[^}]*\}/);
  // The namespace's declaration is unused, and marked pure.
  expect(code).not.toContain(`"counters"`);
});

async function serve(bundle: string, compatibilityFlags: string[] = []) {
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "api",
          compatibilityDate: "2025-09-01",
          compatibilityFlags,
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                type: "esm",
                contents: readFileSync(bundle, "utf8"),
              },
            },
          },
          env: {
            COUNTERS: {
              type: "durable-object",
              worker: "api",
              exportName: "Counter",
            },
          },
          exports: { Counter: { type: "durable-object", storage: "sqlite" } },
        },
      },
    ],
  });
  try {
    const response = await mf.dispatchFetch("http://localhost/");
    return await response.text();
  } finally {
    await mf.dispose();
  }
}

it("runs the worker bundle under workerd, with the Durable Object it re-exports", async () => {
  writeProject();
  await build();
  expect(await serve(path.join(root, apiBundle))).toBe("api COUNTERS count=1");
}, 60_000);

// workerd starts with a warning that no such class is exported, and each call
// to the namespace fails.
it("builds a worker that doesn't re-export the class, whose calls then fail in workerd", async () => {
  writeProject("");
  await build();
  expect(read(apiBundle)).not.toContain("Counter");
  expect(await serve(path.join(root, apiBundle))).toMatch(
    /^Error: internal error; reference = /,
  );
}, 60_000);

it("re-exports a name that is not an identifier", async () => {
  writeProject(`export { Counter as "my-class" } from "./counter";`);
  await build();
  expect(read(apiBundle)).toMatch(/export \{[^}]*as "my-class"[^}]*\}/);
});

it("builds a worker that exports a type without the type keyword", async () => {
  writeProject(`${reexport}\ninterface Local {}\nexport { Local };`);
  await build();
  expect(recordedExports()).toEqual(["Counter"]);
  expect(read(apiBundle)).not.toContain("Local");
});

it("defines NODE_ENV and imports a bare Node built-in as its node: module, over an installed polyfill", async () => {
  writeProject(
    [
      reexport,
      `import { EventEmitter } from "events";`,
      `console.log(process.env.NODE_ENV, typeof EventEmitter);`,
    ].join("\n"),
  );
  write(
    "node_modules/events/package.json",
    JSON.stringify({ name: "events", main: "index.js" }),
  );
  write(
    "node_modules/events/index.js",
    `exports.EventEmitter = function polyfilledEmitter() {};`,
  );
  const warnings = vi.spyOn(console, "warn");
  const logs = vi.spyOn(console, "log");
  await build();
  const code = read(apiBundle);
  expect(code).toMatch(/from "node:events"/);
  expect(code).not.toContain("polyfilledEmitter");
  // vitest sets NODE_ENV to "test".
  expect(code).toContain(`console.log("test", typeof EventEmitter)`);
  expect(code).not.toContain("process.env");
  expect(
    [...warnings.mock.calls, ...logs.mock.calls].flat().join("\n"),
  ).not.toContain("UNRESOLVED_IMPORT");
  expect(await serve(path.join(root, apiBundle), ["nodejs_compat"])).toBe(
    "api COUNTERS count=1",
  );
}, 60_000);

it("runs a CommonJS dependency that requires a Node built-in under workerd", async () => {
  writeProject(
    [
      reexport,
      `import cjs from "cjsdep";`,
      `if (cjs.bare !== "function" || cjs.prefixed !== "function") throw new Error(JSON.stringify(cjs));`,
    ].join("\n"),
  );
  write(
    "node_modules/cjsdep/package.json",
    JSON.stringify({ name: "cjsdep", main: "index.js" }),
  );
  write(
    "node_modules/cjsdep/index.js",
    [
      `const EventEmitter = require("events");`,
      `const { EventEmitter: Prefixed } = require("node:events");`,
      `module.exports = { bare: typeof EventEmitter, prefixed: typeof Prefixed };`,
    ].join("\n"),
  );
  await build();
  expect(read(apiBundle)).not.toMatch(/__require\(/);
  expect(await serve(path.join(root, apiBundle), ["nodejs_compat"])).toBe(
    "api COUNTERS count=1",
  );
}, 60_000);

describe("a runtime: option whose value is not a name that the module declares or imports", () => {
  it.each([
    "ns.Counter",
    `"Counter"`,
    "42",
    "make()",
    "() => Counter",
    "function Foo() {}",
    "null",
    "undefined",
    "Math.random() > 2 ? Counter : null",
  ])('gives class: %s the name "" in the infra bundle', async (value) => {
    writeProject();
    write("runtime/cls.ts", `export class Counter {}`);
    write(
      "runtime/counter.ts",
      `import * as ns from "./cls";\n` +
        counterModule.replace("class: Counter", `class: ${value}`),
    );
    await compileInfra(path.join(root, "infra/main.ts"));
    expect(runInfra("namespace.className")).toBe("");
  });

  it('gives a method the name "" in the infra bundle', async () => {
    writeProject();
    write(
      "runtime/counter.ts",
      counterModule.replace("class: Counter", "class() { return 1; }"),
    );
    await compileInfra(path.join(root, "infra/main.ts"));
    expect(runInfra("namespace.className")).toBe("");
  });
});

describe("an export of the Worker module that workerd doesn't start with", () => {
  it.each([
    [
      "a string",
      `export const version = "1";`,
      "5:14",
      "a primitive, not an object",
    ],
    [
      "null",
      `export const nothing = null;`,
      "5:14",
      "a primitive, not an object",
    ],
    [
      "export * as",
      `export * as all from "./counter";`,
      "5:1",
      "a module namespace object",
    ],
  ])("fails the build for %s", async (_, classExport, at, value) => {
    writeProject(`${reexport}\n${classExport}`);
    await expect(build()).rejects.toThrow(
      `${path.join(root, "runtime/api.ts")}:${at}: the module exports`,
    );
    await expect(build()).rejects.toThrow(`whose value is ${value}.`);
  });

  it.each([
    ["no initialiser", "export let later;"],
    ["a primitive initialiser", "export let later = 0;"],
  ])(
    "builds a Worker that assigns an exported let with %s after its declaration",
    async (_, declaration) => {
      writeProject(`${reexport}\n${declaration}\nlater = { region: "eu" };`);
      await build();
      expect(recordedExports()).toEqual(["Counter", "later"]);
    },
  );

  it("builds and starts a Worker that exports an object", async () => {
    writeProject(`${reexport}\nexport const settings = { region: "eu" };`);
    await build();
    expect(recordedExports()).toEqual(["Counter", "settings"]);
    expect(await serve(path.join(root, apiBundle))).toBe(
      "api COUNTERS count=1",
    );
  }, 60_000);
});

it("drops a cloudflare: import that the infra build doesn't use", async () => {
  writeProject();
  write(
    "runtime/cls.ts",
    [
      `import { DurableObject } from "cloudflare:workers";`,
      `export class Imported extends DurableObject {}`,
      `export const NAME = "counters";`,
    ].join("\n"),
  );
  write(
    "runtime/counter.ts",
    [
      `import { $durableObject } from "@notation/cloudflare/workers";`,
      `import { Imported, NAME } from "./cls";`,
      `export const counters = $durableObject({ id: NAME, class: Imported });`,
    ].join("\n"),
  );
  await compileInfra(path.join(root, "infra/main.ts"));
  const infra = read("dist/infra/main.mjs");
  expect(infra).toContain(`id: "counters"`);
  expect(infra).not.toContain("cloudflare:");
});

describe("a class that extends a cloudflare:workers class in a module without a declaration", () => {
  // Tree shaking keeps each of these classes, as it may have side effects.
  it.each([
    [
      "a static field",
      `export class Imported extends DurableObject { static tag = label("x"); }\nfunction label(x) { return x; }`,
      /Imported = class extends DurableObject \{\s*static tag = label\("x"\);/,
    ],
    [
      "an assignment after the class",
      `export class Imported extends DurableObject {}\nImported.prototype.extra = 1;`,
      /Imported\.prototype\.extra = 1;/,
    ],
    [
      "a mixin",
      `export class Imported extends mixin(DurableObject) {}\nfunction mixin(base) { return base; }`,
      /Imported = class extends mixin\(DurableObject\)/,
    ],
  ])(
    "leaves the class out of the infra build when it has %s, and keeps it in the Worker",
    async (_, cls, inWorker) => {
      writeProject(`${reexport}\nexport { Imported } from "./cls";`);
      write(
        "runtime/cls.ts",
        [
          `import { DurableObject } from "cloudflare:workers";`,
          cls,
          `export const NAME = "counters";`,
        ].join("\n"),
      );
      write(
        "runtime/counter.ts",
        counterModule
          .replace(
            "export const counters",
            `import { Imported, NAME } from "./cls";\nexport const counters`,
          )
          .replace(`id: "counters"`, "id: NAME"),
      );
      await build();
      const infra = read("dist/infra/main.mjs");
      expect(infra).toContain(`id: "counters"`);
      expect(infra).not.toContain("cloudflare:");
      expect(infra).not.toMatch(
        /class Imported|DurableObject|extra|mixin|label\(/,
      );
      const runtime = read(apiBundle);
      expect(runtime).toMatch(
        /import \{ DurableObject \} from "cloudflare:workers"/,
      );
      expect(runtime).toMatch(inWorker);
      expect(runtime).toMatch(/export \{[^}]*\bImported\b[^}]*\}/);
    },
  );
});

it("leaves out what another module builds from a removed class, also in modules that import each other", async () => {
  writeProject();
  write(
    "runtime/cls.ts",
    [
      `import { DurableObject } from "cloudflare:workers";`,
      `import { tag } from "./registry";`,
      `export class Imported extends DurableObject {}`,
      `export const tagged = tag(Imported);`,
      `export const NAME = tag("counters");`,
    ].join("\n"),
  );
  write(
    "runtime/registry.ts",
    [
      `import { Imported, tagged } from "./cls";`,
      `import * as all from "./cls";`,
      `export function tag(value) { return value; }`,
      `globalThis.seen = [Imported, tagged];`,
      `globalThis.viaNamespace = all.tagged;`,
      `globalThis.registered = true;`,
    ].join("\n"),
  );
  write(
    "runtime/counter.ts",
    [
      `import { $durableObject } from "@notation/cloudflare/workers";`,
      `import { Imported, NAME } from "./cls";`,
      `export const counters = $durableObject({ id: NAME, class: Imported });`,
    ].join("\n"),
  );
  await compileInfra(path.join(root, "infra/main.ts"));
  const infra = read("dist/infra/main.mjs");
  expect(infra).not.toContain("cloudflare:");
  expect(infra).not.toContain("tagged");
  expect(
    runInfra(
      `[namespace.id, namespace.className, globalThis.registered, globalThis.seen ?? null, globalThis.viaNamespace ?? null]`,
    ),
  ).toEqual(["counters", "Imported", true, null, null]);
});

it("drops a removed class from an export list and a default export, and keeps the other exports", async () => {
  writeProject();
  write(
    "runtime/cls.ts",
    [
      `import { DurableObject } from "cloudflare:workers";`,
      `class Imported extends DurableObject { static tag = label("x"); }`,
      `function label(x) { return x; }`,
      `const NAME = "counters";`,
      `export { Imported, NAME };`,
      `export default Imported;`,
    ].join("\n"),
  );
  write(
    "runtime/classes.ts",
    `export { Imported as Counter, NAME } from "./cls";\nexport { default } from "./cls";`,
  );
  write(
    "runtime/counter.ts",
    [
      `import { $durableObject } from "@notation/cloudflare/workers";`,
      `import Imported, { Counter, NAME } from "./classes";`,
      `export const one = [Counter, Imported];`,
      `export const counters = $durableObject({ id: NAME, class: Counter });`,
    ].join("\n"),
  );
  await compileInfra(path.join(root, "infra/main.ts"));
  expect(read("dist/infra/main.mjs")).not.toContain("cloudflare:");
  expect(runInfra(`[namespace.id, namespace.className]`)).toEqual([
    "counters",
    "Counter",
  ]);
});

it("removes an infra statement that uses a cloudflare:workers class, also when it has side effects", async () => {
  writeProject();
  write(
    "infra/registry.ts",
    [
      `import { DurableObject } from "cloudflare:workers";`,
      `export const classes = [class extends DurableObject {}];`,
      `export const registry = new Set();`,
    ].join("\n"),
  );
  write(
    "infra/main.ts",
    [
      `import { classes, registry } from "./registry";`,
      `for (const c of classes) registry.add(c);`,
      `globalThis.size = registry.size;`,
    ].join("\n"),
  );
  await compileInfra(path.join(root, "infra/main.ts"));
  expect(read("dist/infra/main.mjs")).not.toContain("cloudflare:");
  expect(runInfra("globalThis.size")).toBe(0);
});

it("fails the infra build on a static cloudflare: import that the strip doesn't remove, and names the importer", async () => {
  writeProject();
  write("infra/registry.ts", `export * from "cloudflare:workers";`);
  write(
    "infra/main.ts",
    `import { DurableObject } from "./registry";\nglobalThis.base = DurableObject;`,
  );
  await expect(compileInfra(path.join(root, "infra/main.ts"))).rejects.toThrow(
    "infra/registry.ts imports cloudflare:workers, and the infra build uses the import. The infra build can't load cloudflare:workers, because only workerd provides it",
  );
});

it("builds an infra module with a dynamic cloudflare: import", async () => {
  writeProject();
  write(
    "infra/main.ts",
    `try { await import("cloudflare:workers"); } catch {}\nexport {};`,
  );
  await expect(
    compileInfra(path.join(root, "infra/main.ts")),
  ).resolves.toBeDefined();
});

it("builds an infra module with an import of another scheme, such as bun:", async () => {
  writeProject();
  write(
    "infra/main.ts",
    `try { await import("bun:sqlite"); } catch {}\nexport {};`,
  );
  await expect(
    compileInfra(path.join(root, "infra/main.ts")),
  ).resolves.toBeDefined();
});

describe("a declaration that uses a class that the infra build leaves out", () => {
  it("fails the infra build for a use outside a runtime: option", async () => {
    writeProject();
    write(
      "runtime/counter.ts",
      counterModule.replace(
        "class: Counter",
        "class: make(Counter), label: Counter.name",
      ) + `\nfunction make(c) { return c; }\n`,
    );
    await expect(
      compileInfra(path.join(root, "infra/main.ts")),
    ).rejects.toThrow(
      "runtime/counter.ts:13:87: the declaration counters uses Counter outside a runtime: option. Counter is not in the infra build, because it uses cloudflare:workers, which only workerd provides, and the infra build runs on Node. Pass Counter only in a runtime: option, such as class: Counter, or move what the infra build needs to a module that doesn't import cloudflare:workers, directly or through other modules.",
    );
  });

  it("names the module that imports cloudflare:workers", async () => {
    writeProject();
    write(
      "runtime/cls.ts",
      [
        `import { DurableObject } from "cloudflare:workers";`,
        `export class Imported extends DurableObject {}`,
        `const CLASS_NAME = Imported.name;`,
        `export { CLASS_NAME };`,
      ].join("\n"),
    );
    write(
      "runtime/counter.ts",
      [
        `import { $durableObject } from "@notation/cloudflare/workers";`,
        `import { Imported, CLASS_NAME } from "./cls";`,
        `const label = CLASS_NAME;`,
        `export const counters = $durableObject({ id: label, class: Imported });`,
      ].join("\n"),
    );
    await expect(
      compileInfra(path.join(root, "infra/main.ts")),
    ).rejects.toThrow(
      "runtime/counter.ts:4:46: the declaration counters uses label outside a runtime: option. label is not in the infra build, because it uses cloudflare:workers, through runtime/cls.ts,",
    );
  });
});
