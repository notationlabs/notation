import { describe, expect, it } from "vitest";
import { assertNameSafe, isNameSafe } from "src/config/name-safe";

describe("isNameSafe", () => {
  it.each(["dev", "orders-app", "a", "pr-123", "0", "a".repeat(32)])(
    "accepts %j",
    (name) => {
      expect(isNameSafe(name)).toBe(true);
    },
  );

  it.each([
    "",
    "Orders",
    "orders_app",
    "orders.app",
    "orders app",
    "-dev",
    "dev-",
    "-",
    "a".repeat(33),
    "ünicode",
    undefined,
    42,
  ])("rejects %j", (name) => {
    expect(isNameSafe(name)).toBe(false);
  });
});

describe("assertNameSafe", () => {
  it("names the value and the rule", () => {
    expect(() => assertNameSafe("Prod", "stage")).toThrow(
      'stage "Prod" is not name-safe: use 1 to 32 characters from a-z, 0-9 and "-", with no leading or trailing "-"',
    );
  });

  it("passes a name-safe value", () => {
    expect(() => assertNameSafe("prod", "stage")).not.toThrow();
  });
});
