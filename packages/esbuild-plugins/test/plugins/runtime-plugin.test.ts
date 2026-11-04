import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { setConfigFile } from "@notation/core";
import { findReads, runtimePlugin } from "src/plugins/runtime-plugin";
import { rewriteRuntimeModule } from "src/runtime-bundle/rewrite";
import {
  buildVirtual,
  projectRoot,
  readVirtualFile,
} from "test/esbuild-test-utils";

beforeAll(() => setConfigFile(path.join(projectRoot, "notation.config.ts")));
afterAll(() => setConfigFile(undefined));

const buildRuntime = (files: Record<string, string>) =>
  buildVirtual(files, "runtime/checkout.ts", [
    runtimePlugin({ getFile: readVirtualFile(files) }),
  ]);

const rewrite = (source: string) =>
  rewriteRuntimeModule("/project/runtime/checkout.ts", source, {
    providers: new Set(["@notation/aws/lambda"]),
    infraModules: new Map([["../infra/orders", "infra/orders"]]),
    readSpecifier: "notation:read",
  });

it("removes the settings of provider factory calls, and the declarations only they use", () => {
  const { code, reads, errors } = rewrite(`
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import { orderQueue } from "../infra/orders" with { type: "infra" };
const grants = [orderQueue.grant(["SendMessage"])];
const memory = 64;
const { handle } = lambda({ id: "checkout", grants, memory: memory * 2 });
export const run = handle.apiRequest(() => ({}));
`);
  expect(errors).toEqual([]);
  expect(code).toContain('from "@notation/aws/lambda.fn"');
  expect(code).toContain("const { handle } = lambda();");
  expect(code).not.toContain("grants");
  expect(code).not.toContain("memory");
  expect(code).not.toContain("orderQueue");
  expect(reads).toEqual([]);
});

it("rewrites each use of an infra import into a pure read", () => {
  const { code, reads, errors } = rewrite(`
import { orderQueue, settings as config } from "../infra/orders" with { type: "infra" };
import * as orders from "../infra/orders" with { type: "infra" };
export const a = () => orderQueue.url;
export const b = () => console.log(orderQueue);
export const c = () => orders.refundQueue["arn"];
export const d = () => ({ config });
export const e = () => orderQueue.url.toUpperCase();
export const f = (orderQueue: string) => orderQueue.length;
type Url = typeof orderQueue.url;
`);
  expect(errors).toEqual([]);
  expect(code).toContain(
    'import { read as __notationRead } from "notation:read";',
  );
  expect(code).not.toContain("../infra/orders");
  expect(code).toContain(
    'export const a = () => /* @__PURE__ */ __notationRead("infra/orders#orderQueue", ["url"]);',
  );
  expect(code).toContain(
    'console.log(/* @__PURE__ */ __notationRead("infra/orders#orderQueue", []))',
  );
  expect(code).toContain(
    '/* @__PURE__ */ __notationRead("infra/orders#refundQueue", ["arn"])',
  );
  expect(code).toContain(
    '({ config: /* @__PURE__ */ __notationRead("infra/orders#settings", []) })',
  );
  expect(code).toContain(
    '/* @__PURE__ */ __notationRead("infra/orders#orderQueue", ["url"]).toUpperCase()',
  );
  expect(code).toContain("(orderQueue: string) => orderQueue.length");
  expect(code).toContain("type Url = typeof orderQueue.url;");
  expect(reads).toEqual([
    "infra/orders#orderQueue",
    "infra/orders#orderQueue.url",
    "infra/orders#refundQueue.arn",
    "infra/orders#settings",
  ]);
});

it("fails when runtime code calls infra, changes it, or uses a namespace import as a value", () => {
  const { errors } = rewrite(`
import { orderQueue } from "../infra/orders" with { type: "infra" };
import * as orders from "../infra/orders" with { type: "infra" };
export const a = () => orderQueue.grant(["SendMessage"]);
export const b = () => { orderQueue.url = "x"; };
export const c = () => console.log(orders);
`);
  expect(errors.map((error) => [error.text, error.location?.line])).toEqual([
    [
      expect.stringContaining(
        "orderQueue.grant() calls infra from runtime code",
      ),
      4,
    ],
    [expect.stringContaining("Runtime code can't change orderQueue.url"), 5],
    [
      expect.stringContaining(
        "orders is a namespace import of infra, which runtime code can't use as a value",
      ),
      6,
    ],
  ]);
});

it("bundles a provider's runtime half, and drops infra that only the settings use", async () => {
  const output = await buildRuntime({
    "runtime/checkout.ts": `
      import { lambda } from "@notation/aws/lambda" with { type: "infra" };
      import { orderQueue } from "../infra/orders" with { type: "infra" };
      const { handle } = lambda({ id: "checkout", grants: [orderQueue.grant(["SendMessage"])] });
      export const run = handle.apiRequest(() => ({}));
    `,
    "infra/orders.ts": `export const orderQueue = { grant: () => ({}) };`,
  });

  expect(output).toContain('from "@notation/aws/lambda.fn"');
  expect(output).toContain("lambda()");
  expect(output).not.toContain("orderQueue");
  expect(output).not.toContain("with {");
});

it("fails on type: runtime in runtime code", async () => {
  await expect(
    buildRuntime({
      "runtime/checkout.ts": `import * as other from "./other" with { type: "runtime" }; console.log(other);`,
      "runtime/other.ts": `export const x = 1;`,
    }),
  ).rejects.toThrow(
    'with { type: "runtime" } is only valid in infra modules, and runtime/checkout.ts is runtime code',
  );
});

it("lists the reads left in each output after tree-shaking", async () => {
  let reads: Record<string, string[]> = {};
  const files = {
    "runtime/checkout.ts": `
      import { orderQueue } from "../infra/orders" with { type: "infra" };
      const unused = () => orderQueue.arn;
      orderQueue.id;
      export const run = () => orderQueue.url;
    `,
    "infra/orders.ts": `export const orderQueue = { url: "x" };`,
  };
  const output = await buildVirtual(files, "runtime/checkout.ts", [
    runtimePlugin({
      getFile: readVirtualFile(files),
      onReads: (found) => {
        reads = found;
      },
    }),
  ]);

  expect(output).toContain('from "@notation/resource/outputs"');
  expect(findReads(output)).toEqual(["infra/orders#orderQueue.url"]);
  expect(Object.values(reads)).toEqual([["infra/orders#orderQueue.url"]]);
});

it("fails when runtime code imports an infra package without the attribute", async () => {
  await expect(
    buildRuntime({
      "runtime/checkout.ts": `import { orderQueue } from "../infra/orders"; console.log(orderQueue);`,
      "infra/orders.ts": `import { queue } from "@notation/aws/sqs"; export const orderQueue = queue({ name: "orders" });`,
    }),
  ).rejects.toThrow(
    'infra/orders.ts imports @notation/aws/sqs without { type: "infra" }, so the bundle of runtime code would include infra',
  );
});
