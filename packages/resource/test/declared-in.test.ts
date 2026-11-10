import { expect, it } from "vitest";
import { declaredIn, getDeclaredIn } from "src";

it("records the module, the binding and the module's exports", () => {
  const worker = declaredIn({ id: "api" }, "runtime/api.ts", "worker", {
    exports: ["Counter"],
    starExports: ["./other"],
  });
  expect(getDeclaredIn(worker)).toEqual({
    path: "runtime/api.ts",
    binding: "worker",
    exports: ["Counter"],
    starExports: ["./other"],
  });
});

it("records only the module and the binding without the exports", () => {
  const fn = declaredIn(() => {}, "runtime/jobs.ts", "fn");
  expect(getDeclaredIn(fn)).toEqual({ path: "runtime/jobs.ts", binding: "fn" });
});

it("records nothing on a primitive, and returns it", () => {
  expect(declaredIn("api", "runtime/api.ts", "worker")).toBe("api");
  expect(getDeclaredIn("api")).toBeUndefined();
});
