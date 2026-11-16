import { expect, it } from "vitest";
import { isResourceClass } from "@notation/resource";
import * as resources from "src/resources";

it("exports resource classes that name this subpath as their provider", () => {
  const classes = Object.values(resources as Record<string, unknown>).filter(
    isResourceClass,
  );
  expect(classes.map((Resource) => Resource.type)).toEqual([
    "build/bundle/Bundle",
  ]);
  for (const Resource of classes) {
    expect(Resource.provider).toBe("@notation/build/resources");
  }
});
