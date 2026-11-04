import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readRuntimeReads } from "src/orchestrator/graph";
import { setConfigFile } from "src/utils/paths";

let tmp: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(tmpdir(), "notation-reads-")));
  setConfigFile(path.join(tmp, "notation.config.ts"));
});

afterEach(async () => {
  setConfigFile(undefined);
  await rm(tmp, { recursive: true, force: true });
});

const fn = {
  id: "checkout",
  service: "aws/lambda",
  bundle: "dist/functions/checkout/index.mjs",
  handlers: [],
};

it("reads the keys listed in reads.json next to the bundle", async () => {
  await mkdir(path.join(tmp, "dist/functions/checkout"), { recursive: true });
  await writeFile(
    path.join(tmp, "dist/functions/checkout/reads.json"),
    JSON.stringify({ reads: ["infra/orders#orderQueue.url"] }),
  );
  expect(readRuntimeReads(fn)).toEqual(["infra/orders#orderQueue.url"]);
});

it("throws when reads.json is missing, naming the function and the path", () => {
  const file = path.join(tmp, "dist/functions/checkout/reads.json");
  expect(() => readRuntimeReads(fn)).toThrow(
    `The function "checkout" has no list of the values it reads from infra at ${file}. The compiler writes it next to the function's bundle. Compile the app again.`,
  );
});
