import { expect, it } from "vitest";
import { collectResourceGraph, physicalName, scopedPhysicalName } from "src";

const scope = { app: "orders-app", stage: "prod" };

it("prefixes the name with the app and stage", () => {
  expect(physicalName(scope, "get-orders", { maxLength: 64 })).toBe(
    "orders-app-prod-get-orders",
  );
});

it("leaves the name as it is without a scope", () => {
  expect(physicalName(undefined, "get-orders", { maxLength: 64 })).toBe(
    "get-orders",
  );
});

it("keeps a name of exactly the maximum length", () => {
  const name = "x".repeat(64 - "orders-app-prod-".length);
  expect(physicalName(scope, name, { maxLength: 64 })).toBe(
    `orders-app-prod-${name}`,
  );
});

it("shortens a long name and ends it with a hash of the full name", () => {
  const name = `${"a".repeat(50)}-role`;
  const result = physicalName(scope, name, { maxLength: 64 });
  expect(result).toHaveLength(64);
  expect(result).toMatch(/^orders-app-prod-a+-[0-9a-f]{8}$/);
  expect(physicalName(scope, name, { maxLength: 64 })).toBe(result);
});

it("gives different hashes to long names that share a prefix", () => {
  const a = physicalName(scope, `${"a".repeat(60)}-one`, { maxLength: 64 });
  const b = physicalName(scope, `${"a".repeat(60)}-two`, { maxLength: 64 });
  expect(a.slice(0, 55)).toBe(b.slice(0, 55));
  expect(a).not.toBe(b);
});

it("gives different names to stages whose long names share a prefix", () => {
  const name = "a".repeat(60);
  const prod = physicalName(scope, name, { maxLength: 64 });
  const staging = physicalName({ ...scope, stage: "staging" }, name, {
    maxLength: 64,
  });
  expect(prod).not.toBe(staging);
});

it("does not leave a separator before the hash", () => {
  // The cut falls just after the hyphen in "orders-app-prod-ab-".
  const result = physicalName(scope, `ab-${"c".repeat(60)}`, {
    maxLength: 28,
  });
  expect(result).toMatch(/^orders-app-prod-ab-[0-9a-f]{8}$/);
});

it("keeps a required ending at the end of a shortened name", () => {
  const name = `${"q".repeat(80)}.fifo`;
  const result = physicalName(scope, name, {
    maxLength: 80,
    requiredEnding: ".fifo",
  });
  expect(result).toHaveLength(80);
  expect(result).toMatch(/^orders-app-prod-q+-[0-9a-f]{8}\.fifo$/);
});

it("scopes names by the app and stage of the active collection", async () => {
  let name = "";
  await collectResourceGraph(
    () => {
      name = scopedPhysicalName("get-orders", { maxLength: 64 });
    },
    { scope },
  );
  expect(name).toBe("orders-app-prod-get-orders");
});

it("does not scope names outside a collection", () => {
  expect(scopedPhysicalName("get-orders", { maxLength: 64 })).toBe(
    "get-orders",
  );
});

// Changing the hash renames, and so replaces, every shortened resource.
it("uses a hash that does not change between releases", () => {
  expect(physicalName(scope, "a".repeat(60), { maxLength: 64 })).toBe(
    `orders-app-prod-${"a".repeat(39)}-0623bc13`,
  );
});
