import { fileURLToPath } from "node:url";
import { Marks } from "@notation/build";
import { describe, expect, it } from "vitest";
import { workerOutputs } from "src/workers/outputs";
import { $worker } from "src/workers/runtime";

const workerSource = fileURLToPath(
  new URL("../../src/workers/worker.ts", import.meta.url),
);

it("lists the same outputs in $worker's mark as in workerOutputs", () => {
  const mark = new Marks().table(workerSource)?.marks.get("$worker");
  expect(mark).toMatchObject({ kind: "declaration" });
  expect(mark?.kind === "declaration" && mark.outputs).toEqual([
    ...workerOutputs,
  ]);
});

describe("the runtime $worker", () => {
  const api = $worker({ id: "api", compatibilityDate: "2026-10-12" });
  const message =
    'Worker code read url, an output of $worker({ id: "api" }). An output is known only at deploy, so Worker code can\'t read it. Bind it to the Worker that needs it, and read it from env.';

  it("throws for a read of an output through a helper that the build can't follow", () => {
    const urlOf = (worker: object) => (worker as { url?: unknown }).url;
    expect(() => urlOf(api)).toThrow(message);
  });

  it("keeps each output out of the enumerable keys, so a spread doesn't read it", () => {
    expect(Object.keys(api)).toEqual(["id"]);
    expect({ ...api }).toEqual({ id: "api" });
  });
});
