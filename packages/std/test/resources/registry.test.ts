import { expect, it } from "vitest";
import { isResourceClass } from "@notation/resource";
import * as std from "src/resources";

it("exports only namespaces of resource classes that name this subpath as their provider", () => {
  const exported = Object.values(std).flatMap((namespace) =>
    Object.values(namespace),
  );
  expect(exported.length).toBeGreaterThan(0);
  for (const Resource of exported) {
    expect(isResourceClass(Resource)).toBe(true);
    expect((Resource as { provider: string }).provider).toBe(
      "@notation/std/resources",
    );
  }
});
