import { expect, it } from "vitest";
import * as std from "src/index";

it("each class names this package as its provider", () => {
  expect(std.resourceClasses.length).toBeGreaterThan(0);
  for (const Resource of std.resourceClasses) {
    expect(Resource.provider).toBe("@notation/std.iac");
  }
});
