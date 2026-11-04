import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { setConfigFile } from "@notation/core";
import {
  removeFactoryArguments,
  runtimePlugin,
} from "src/plugins/runtime-plugin";
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

it("removes the settings of provider factory calls", () => {
  const source = `
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import { orderQueue } from "../infra/orders" with { type: "infra" };
const { handle } = lambda({ id: "checkout", grants: [orderQueue.grant(["SendMessage"])] });
export const run = handle.apiRequest(() => ({}));
`;
  expect(
    removeFactoryArguments(
      "/project/runtime/checkout.ts",
      source,
      new Set(["@notation/aws/lambda"]),
    ),
  ).toContain("const { handle } = lambda();");
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

it("fails when runtime code reads an infra module", async () => {
  await expect(
    buildRuntime({
      "runtime/checkout.ts": `import { orderQueue } from "../infra/orders" with { type: "infra" }; console.log(orderQueue.url);`,
      "infra/orders.ts": `export const orderQueue = { url: "x" };`,
    }),
  ).rejects.toThrow(
    "runtime/checkout.ts reads ../infra/orders, an infra module, from runtime code",
  );
});
