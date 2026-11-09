import { expect, it } from "vitest";
import * as aws from "src/index";

it("resourceClasses holds every resource class the package exports", () => {
  const exported = Object.values(aws).flatMap((namespace) =>
    typeof namespace === "object" && namespace !== null
      ? Object.values(namespace).filter(
          (value) => typeof value === "function" && "type" in value,
        )
      : [],
  );
  expect(new Set(aws.resourceClasses)).toEqual(new Set(exported));
});
