import { declaredIn, getDeclaredIn } from "@notation/resource";
import { expect, it } from "vitest";
import { declaredInHelper, declaredInSource } from "src/infra-strip";

// The copy that the infra build writes into each declaration module.
const writtenCopy: typeof declaredIn = new Function(
  `${declaredInSource}\nreturn ${declaredInHelper};`,
)();

it.each([
  ["an object, with the module's exports", () => ({ id: "api" }), true],
  ["an object, without the module's exports", () => ({ id: "api" }), false],
  ["a function", () => () => {}, false],
])(
  "records the same as declaredIn from @notation/resource, on %s",
  (_, make, withExports) => {
    const moduleExports = withExports
      ? { exports: ["Counter"], starExports: ["./other"] }
      : undefined;
    const written = writtenCopy(
      make(),
      "runtime/api.ts",
      "worker",
      moduleExports,
    );
    const recorded = declaredIn(
      make(),
      "runtime/api.ts",
      "worker",
      moduleExports,
    );
    expect(getDeclaredIn(written)).toEqual(getDeclaredIn(recorded));
    expect(getDeclaredIn(written)).toBeDefined();
  },
);

it("returns a primitive as it is, and records nothing, as declaredIn does", () => {
  expect(writtenCopy("api", "runtime/api.ts", "worker")).toBe("api");
  expect(declaredIn("api", "runtime/api.ts", "worker")).toBe("api");
});
