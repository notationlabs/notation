import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isNameSafe } from "@notation/core/config";
import { setConfigApp, toNameSafe } from "../src/app-name";

describe("toNameSafe", () => {
  it.each([
    ["my-app", "my-app"],
    ["My_App", "my-app"],
    ["apps/My App!", "my-app"],
    ["--my--app--", "my-app"],
    ["a".repeat(40), "a".repeat(32)],
    [`${"a".repeat(31)}-b`, "a".repeat(31)],
    ["___", "notation-app"],
  ])("turns %j into %j", (name, expected) => {
    expect(toNameSafe(name)).toBe(expected);
    expect(isNameSafe(toNameSafe(name))).toBe(true);
  });
});

describe("setConfigApp", () => {
  it("sets the app in the starter's config", async () => {
    const config = await readFile(
      path.join(import.meta.dirname, "../templates/starter/notation.config.ts"),
      "utf8",
    );

    const updated = setConfigApp(config, "my-app");

    expect(updated).toContain('app: "my-app"');
    expect(updated).not.toContain("notation-starter");
  });

  it("fails when the config has no app to replace", () => {
    expect(() => setConfigApp(`export default {};`, "my-app")).toThrow(
      'The starter notation.config.ts has no app: "notation-starter" to replace',
    );
  });
});
