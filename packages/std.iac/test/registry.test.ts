import { expect, it } from "vitest";
import * as std from "src/index";

it("resourceClasses holds every resource class the package exports", () => {
  const exported = Object.values(std).flatMap((namespace) =>
    typeof namespace === "object" && namespace !== null
      ? Object.values(namespace).filter(
          (value) => typeof value === "function" && "type" in value,
        )
      : [],
  );
  expect(new Set(std.resourceClasses)).toEqual(new Set(exported));
});
