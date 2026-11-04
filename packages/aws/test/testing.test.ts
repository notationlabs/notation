import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { clearOutputs, infraBinding, setOutputs } from "src/testing/outputs";
import { exportNames, infraModuleSource } from "src/testing/served";

const run = promisify(execFile);
const fixtures = path.join(import.meta.dirname, "fixtures");
const checkout = path.join(fixtures, "testing");

afterEach(() => clearOutputs());

test("a property read gives the value set for its key", () => {
  setOutputs({ "infra/orders#orderQueue.url": "https://sqs.test/orders" });
  const orderQueue: any = infraBinding("infra/orders", "orderQueue");
  expect(orderQueue.url).toBe("https://sqs.test/orders");
});

test("a key without a property path sets the whole binding", () => {
  setOutputs({ "infra/orders#orderQueue": { url: "u", arn: "a" } });
  const orderQueue: any = infraBinding("infra/orders", "orderQueue");
  expect([orderQueue.url, orderQueue.arn]).toEqual(["u", "a"]);
  expect(JSON.stringify(orderQueue)).toBe('{"url":"u","arn":"a"}');
});

test("a dotted key sets a nested property", () => {
  setOutputs({ "infra/api#api.stage.url": "https://api.test" });
  const api: any = infraBinding("infra/api", "api");
  expect(api.stage.url).toBe("https://api.test");
});

test("reading an unset value throws, naming its key", () => {
  const orderQueue: any = infraBinding("infra/orders", "orderQueue");
  expect(() => orderQueue.url).toThrow(
    'No output is set for "infra/orders#orderQueue.url". Set it in the test with setOutputs({ "infra/orders#orderQueue.url": ... }).',
  );
});

test("grant stays callable, so lambda() settings can run", () => {
  const orderQueue: any = infraBinding("infra/orders", "orderQueue");
  expect(() => orderQueue.grant(["SendMessage"])).not.toThrow();
});

test("setOutputs rejects a key that isn't an output key", () => {
  expect(() => setOutputs({ orderQueue: "x" })).toThrow(
    '"orderQueue" is not an output key',
  );
});

test("the served module exports each binding of the infra module", () => {
  const file = path.join(checkout, "infra/orders.ts");
  expect(exportNames(file)).toEqual(["orderQueue"]);
  expect(infraModuleSource(file, "/testing.js")).toBe(
    [
      'import { infraBinding } from "/testing.js";',
      'const _0 = infraBinding("infra/orders", "orderQueue");',
      "export { _0 as orderQueue };",
    ].join("\n"),
  );
});

test("a test runs under the loader hook in Node", async () => {
  const { stdout } = await run(
    process.execPath,
    [
      "--import",
      "@notation/aws/testing/register",
      "--test",
      "--test-reporter=tap",
      "runtime/checkout.node.test.ts",
    ],
    { cwd: checkout },
  );
  expect(stdout).toContain("# pass 2");
  expect(stdout).toContain("# fail 0");
});

test("a test runs under the Vitest plugin", async () => {
  const vitest = path.join(
    path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
    "vitest.mjs",
  );
  const { stdout } = await run(process.execPath, [vitest, "run"], {
    cwd: checkout,
  });
  expect(stdout).toMatch(/Tests\s+2 passed/);
}, 30_000);

test("the loader hook avoids Node's overflow on attributed TypeScript cycles", async () => {
  const { stdout } = await run(
    process.execPath,
    ["--import", "@notation/aws/testing/register", "self.ts"],
    { cwd: path.join(fixtures, "attribute-cycle") },
  );
  expect(stdout.trim()).toBe("name");
});
