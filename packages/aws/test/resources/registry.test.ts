import { expect, it } from "vitest";
import { isResourceClass } from "@notation/resource";
import * as aws from "src/resources";

it("exports resource classes that name this subpath as their provider", () => {
  const classes = Object.values(aws)
    .flatMap((namespace) => Object.values(namespace))
    .filter(isResourceClass);
  expect(classes.length).toBeGreaterThan(0);
  for (const Resource of classes) {
    expect(Resource.provider).toBe("@notation/aws/resources");
  }
});
