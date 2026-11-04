import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripRuntimeModules } from "src/infra-phase/strip";

const root = "/project";

async function strip(files: Record<string, string>, entries: string[]) {
  const result = await stripRuntimeModules(
    entries.map((entry) => path.join(root, entry)),
    {
      getFile: (file) => {
        const contents = files[path.relative(root, file)];
        if (contents === undefined) throw new Error(`No file ${file}`);
        return contents;
      },
      resolve: async (specifier, importer) => {
        if (!specifier.startsWith("."))
          return { path: specifier, local: false };
        const resolved = path.resolve(path.dirname(importer), specifier);
        const relative = path.relative(root, resolved);
        const file = [relative, `${relative}.ts`].find((f) => f in files);
        return { path: path.join(root, file ?? relative), local: true };
      },
      isRuntimeModule: (file) => file.includes("/runtime/"),
      describe: (file) => path.relative(root, file),
    },
  );
  return Object.fromEntries(
    [...result.modules].map(([file, code]) => [
      path.relative(root, file),
      code,
    ]),
  );
}

const infraImports = `
import { json } from "@notation/aws/lambda.fn";
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import { orderQueue } from "../infra/orders" with { type: "infra" };
import { sendMessage } from "./sqs-client";
`;

describe("stripped copies", () => {
  it("keep the lambda() call and the handlers it makes, and drop handler bodies", async () => {
    const modules = await strip(
      {
        "runtime/checkout.ts": `${infraImports}
const { handle } = lambda({ id: "checkout", timeout: 5, grants: [orderQueue.grant(["SendMessage"])] });

console.log("loading");
const client = await connect();

export const createOrder = handle.apiRequest(async (req) => {
  await sendMessage(orderQueue.url, req.body);
  return json({ ok: true });
});

export const processOrder = handle.sqsEvent(async (event) => {
  for (const record of event.Records) console.log(record.body);
});

export function helper() { return client; }
export type Order = { id: string };
`,
        "runtime/sqs-client.ts": `export const sendMessage = () => {};`,
      },
      ["runtime/checkout.ts"],
    );

    expect(Object.keys(modules)).toEqual(["runtime/checkout.ts"]);
    expect(modules["runtime/checkout.ts"]).toBe(
      [
        `const __notationInert = () => { throw new Error("A handler doesn't run in the infra phase."); };`,
        `import { lambda as lambda } from "@notation/aws/lambda";`,
        `import { orderQueue as orderQueue } from "../infra/orders";`,
        `const { handle } = lambda({ id: "checkout", timeout: 5, grants: [orderQueue.grant(["SendMessage"])] });`,
        `export const createOrder = handle.apiRequest(__notationInert);`,
        `export const processOrder = handle.sqsEvent(__notationInert);`,
        `const __notationDropped0 = undefined;`,
        `export { __notationDropped0 as helper };`,
        ``,
      ].join("\n"),
    );
  });

  it("keep what the settings reference, and statements that update it", async () => {
    const modules = await strip(
      {
        "runtime/checkout.ts": `
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import { orderQueue } from "../infra/orders" with { type: "infra" };
import { baseMemory } from "./settings";
import "./env-setup";

const settings = { id: \`checkout-\${orderQueue.name}\`, memory: baseMemory };
settings.memory *= 2;
Object.assign(settings, { timeout: 5 });
console.log(settings);
function bump() { settings.memory += 1; }
bump();

export const { handle } = lambda(settings);
export const run = handle.apiRequest(() => ({}));
`,
        "runtime/settings.ts": `
import { SQSClient } from "@aws-sdk/client-sqs";
export const baseMemory = 128;
export const client = new SQSClient({});
`,
        "runtime/env-setup.ts": `globalThis.x = 1;`,
      },
      ["runtime/checkout.ts"],
    );

    expect(modules["runtime/checkout.ts"]).toBe(
      [
        `const __notationInert = () => { throw new Error("A handler doesn't run in the infra phase."); };`,
        `import { lambda as lambda } from "@notation/aws/lambda";`,
        `import { orderQueue as orderQueue } from "../infra/orders";`,
        `import { baseMemory as baseMemory } from "notation-stripped:/project/runtime/settings.ts";`,
        "const settings = { id: `checkout-${orderQueue.name}`, memory: baseMemory };",
        `settings.memory *= 2;`,
        `Object.assign(settings, { timeout: 5 });`,
        `export const { handle } = lambda(settings);`,
        `export const run = handle.apiRequest(__notationInert);`,
        ``,
      ].join("\n"),
    );
    expect(modules["runtime/settings.ts"]).toBe(
      [
        `export const baseMemory = 128;`,
        `const __notationDropped0 = undefined;`,
        `export { __notationDropped0 as client };`,
        ``,
      ].join("\n"),
    );
    expect(modules["runtime/env-setup.ts"]).toBeUndefined();
  });

  it("carry derived bindings across files", async () => {
    const modules = await strip(
      {
        "runtime/fn.ts": `
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
export const checkoutFn = lambda({ id: "checkout" });
export const handle = checkoutFn.handle;
export const unrelated = () => fetch("x");
`,
        "runtime/checkout.ts": `
import { handle } from "./fn";
export const createOrder = handle.apiRequest(() => ({}));
`,
        "runtime/reexport.ts": `
export * from "./checkout";
export { checkoutFn as fn } from "./fn";
`,
      },
      ["runtime/reexport.ts"],
    );

    expect(modules["runtime/reexport.ts"]).toBe(
      [
        `export * from "notation-stripped:/project/runtime/checkout.ts";`,
        `export { checkoutFn as fn } from "notation-stripped:/project/runtime/fn.ts";`,
        ``,
      ].join("\n"),
    );
    expect(modules["runtime/checkout.ts"]).toBe(
      [
        `const __notationInert = () => { throw new Error("A handler doesn't run in the infra phase."); };`,
        `import { handle as handle } from "notation-stripped:/project/runtime/fn.ts";`,
        `export const createOrder = handle.apiRequest(__notationInert);`,
        ``,
      ].join("\n"),
    );
    expect(modules["runtime/fn.ts"]).toBe(
      [
        `import { lambda as lambda } from "@notation/aws/lambda";`,
        `export const checkoutFn = lambda({ id: "checkout" });`,
        `export const handle = checkoutFn.handle;`,
        `const __notationDropped0 = undefined;`,
        `export { __notationDropped0 as unrelated };`,
        ``,
      ].join("\n"),
    );
  });

  it("keep a handler that isn't exported, so linking can report it", async () => {
    const modules = await strip(
      {
        "runtime/checkout.ts": `
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
const { handle } = lambda({ id: "checkout" });
handle.apiRequest(() => ({}));
`,
      },
      ["runtime/checkout.ts"],
    );
    expect(modules["runtime/checkout.ts"]).toContain(
      "handle.apiRequest(__notationInert);",
    );
  });

  it("keep the helpers and classes that settings call, whole", async () => {
    const modules = await strip(
      {
        "runtime/checkout.ts": `
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import { orderQueue } from "../infra/orders" with { type: "infra" };
const prefix = "checkout";
const unused = "x";
function makeId(name: string) { return \`\${prefix}-\${name}\`; }
class Settings { static memory = 256; }
const { handle } = lambda({ id: makeId(orderQueue.name), memory: Settings.memory });
export const run = handle.apiRequest(() => unused);
`,
      },
      ["runtime/checkout.ts"],
    );
    const code = modules["runtime/checkout.ts"]!;
    expect(code).toContain(`const prefix = "checkout";`);
    expect(code).toContain("function makeId(name: string)");
    expect(code).toContain("class Settings { static memory = 256; }");
    expect(code).not.toContain("unused");
  });

  it("reject type: runtime in runtime code", async () => {
    await expect(
      strip(
        {
          "runtime/a.ts": `import * as b from "./b" with { type: "runtime" };`,
          "runtime/b.ts": ``,
        },
        ["runtime/a.ts"],
      ),
    ).rejects.toThrow(
      'runtime/a.ts imports ./b with { type: "runtime" }, which is only valid in infra modules',
    );
  });

  it("reject type: infra imports of runtime modules", async () => {
    await expect(
      strip(
        {
          "runtime/a.ts": `import { x } from "./b" with { type: "infra" };`,
          "runtime/b.ts": `export const x = 1;`,
        },
        ["runtime/a.ts"],
      ),
    ).rejects.toThrow(
      'runtime/a.ts imports ./b with { type: "infra" }, but it is a runtime module',
    );
  });
});
