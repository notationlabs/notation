import { fileURLToPath } from "node:url";
import { Marks } from "@notation/build";
import { describe, expect, it } from "vitest";
import { $worker } from "src/workers/runtime";

const workerSource = fileURLToPath(
  new URL("../../src/workers/worker.ts", import.meta.url),
);

describe("the runtime $worker", () => {
  const api = $worker({ id: "api", compatibilityDate: "2026-10-12" });
  const mark = new Marks().table(workerSource)?.marks.get("$worker");
  const outputs = mark?.kind === "declaration" ? (mark.outputs ?? []) : [];

  it("lists url in the outputs: clause of $worker's mark", () => {
    expect(outputs).toContain("url");
  });

  it.each(outputs)(
    "defines %s as a getter that throws and isn't enumerable",
    (output) => {
      const descriptor = Object.getOwnPropertyDescriptor(api, output);
      expect(descriptor?.enumerable).toBe(false);
      expect(descriptor?.get).toBeTypeOf("function");
      expect(() => Reflect.get(api, output)).toThrow(
        `Worker code read ${output}, an output of $worker({ id: "api" }). An output is known only at deploy, so Worker code can't read it. Bind it to the Worker that needs it, and read it from env.`,
      );
    },
  );

  it("keeps each output out of a spread", () => {
    expect({ ...api }).toEqual({ id: "api" });
  });
});
