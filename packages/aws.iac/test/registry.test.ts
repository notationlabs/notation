import { expect, it } from "vitest";
import * as aws from "src/index";

it("each class names this package as its provider", () => {
  expect(aws.resourceClasses.length).toBeGreaterThan(0);
  for (const Resource of aws.resourceClasses) {
    expect(Resource.provider).toBe("@notation/aws.iac");
  }
});
