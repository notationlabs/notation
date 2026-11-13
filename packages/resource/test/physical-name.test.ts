import { expect, it } from "vitest";
import {
  collectResourceGraph,
  generatedPhysicalName,
  physicalName,
  resource,
  scopedPhysicalName,
} from "src";
import { string } from "./validators";

const scope = { app: "orders-app", stage: "prod" };

it("prefixes the name with the app and stage", () => {
  expect(physicalName(scope, "get-orders", { maxLength: 64 })).toBe(
    "orders-app--prod--get-orders",
  );
});

it("leaves the name as it is without a scope", () => {
  expect(physicalName(undefined, "get-orders", { maxLength: 64 })).toBe(
    "get-orders",
  );
});

it("keeps a name of exactly the maximum length", () => {
  const name = "x".repeat(64 - "orders-app--prod--".length);
  expect(physicalName(scope, name, { maxLength: 64 })).toBe(
    `orders-app--prod--${name}`,
  );
});

it("shortens a long name and ends it with a hash of the full name", () => {
  const name = `${"a".repeat(50)}-role`;
  const result = physicalName(scope, name, { maxLength: 64 });
  expect(result).toHaveLength(64);
  expect(result).toMatch(/^orders-app--prod--a+-[0-9a-f]{8}$/);
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
  // The cut falls just after the hyphen in "orders-app--prod--ab-".
  const result = physicalName(scope, `ab-${"c".repeat(60)}`, {
    maxLength: 30,
  });
  expect(result).toMatch(/^orders-app--prod--ab-[0-9a-f]{8}$/);
});

it("keeps a required ending at the end of a shortened name", () => {
  const name = `${"q".repeat(80)}.fifo`;
  const result = physicalName(scope, name, {
    maxLength: 80,
    requiredEnding: ".fifo",
  });
  expect(result).toHaveLength(80);
  expect(result).toMatch(/^orders-app--prod--q+-[0-9a-f]{8}\.fifo$/);
});

it("scopes names by the app and stage of the active collection", async () => {
  let name = "";
  await collectResourceGraph(
    () => {
      name = scopedPhysicalName("get-orders", { maxLength: 64 });
    },
    { scope },
  );
  expect(name).toBe("orders-app--prod--get-orders");
});

it("does not scope names outside a collection", () => {
  expect(scopedPhysicalName("get-orders", { maxLength: 64 })).toBe(
    "get-orders",
  );
});

// Changing the hash renames, and so replaces, every shortened resource.
it("uses a hash that does not change between releases", () => {
  expect(physicalName(scope, "a".repeat(60), { maxLength: 64 })).toBe(
    `orders-app--prod--${"a".repeat(37)}-386c3ec7`,
  );
});

it("generates a name from the app, stage, resource ID and instance", () => {
  expect(
    generatedPhysicalName(
      scope,
      "lambda:get-orders:role",
      "1a2b3c4d",
      { maxLength: 64 },
      {},
    ),
  ).toBe("orders-app--prod--lambda-get-orders-role-1a2b3c4d");
});

it("takes the base of a generated name from the rule's base", () => {
  const rule = {
    maxLength: 64,
    base: (resourceId: string) => resourceId.replace(/^lambda:/, ""),
  };
  const generate = (resourceId: string) =>
    generatedPhysicalName(scope, resourceId, "1a2b3c4d", rule, {});

  expect(generate("lambda:get-orders")).toBe(
    "orders-app--prod--get-orders-1a2b3c4d",
  );
  // The result of base is made valid as a resource ID is.
  expect(generate("lambda:Get_Orders:role")).toBe(
    "orders-app--prod--get-orders-role-1a2b3c4d",
  );
});

it("generates a name of lower-case letters, digits and single hyphens from any resource ID", () => {
  expect(
    generatedPhysicalName(
      scope,
      ":Route:GET /Orders/{id}__v2--x:",
      "1a2b3c4d",
      { maxLength: 64 },
      {},
    ),
  ).toBe("orders-app--prod--route-get-orders-id-v2-x-1a2b3c4d");
});

it("shortens a generated name before the instance", () => {
  const result = generatedPhysicalName(
    scope,
    `lambda:${"x".repeat(60)}:role`,
    "1a2b3c4d",
    { maxLength: 64 },
    {},
  );
  expect(result).toHaveLength(64);
  expect(result).toMatch(/^orders-app--prod--lambda-x+-1a2b3c4d$/);
});

it("does not end the shortened part of a generated name with a hyphen", () => {
  // The cut falls just after the hyphen that follows "lambda".
  const result = generatedPhysicalName(
    scope,
    "lambda:orders",
    "1a2b3c4d",
    { maxLength: "orders-app--prod--lambda-".length + 9 },
    {},
  );
  expect(result).toBe("orders-app--prod--lambda-1a2b3c4d");
});

it("ends a generated name with the required ending when the rule's param is true", () => {
  const rule = {
    maxLength: 80,
    requiredEnding: ".fifo",
    requiredEndingWhen: "FifoQueue",
  };
  const generate = (params: Record<string, unknown>, maxLength = 80) =>
    generatedPhysicalName(
      scope,
      "sqs-queue:orders",
      "1a2b3c4d",
      { ...rule, maxLength },
      params,
    );

  expect(generate({ FifoQueue: true })).toBe(
    "orders-app--prod--sqs-queue-orders-1a2b3c4d.fifo",
  );
  expect(generate({ FifoQueue: true }, 40)).toBe(
    "orders-app--prod--sqs-queu-1a2b3c4d.fifo",
  );
  expect(generate({ FifoQueue: false })).toBe(
    "orders-app--prod--sqs-queue-orders-1a2b3c4d",
  );
  expect(generate({})).toBe("orders-app--prod--sqs-queue-orders-1a2b3c4d");
});

it("throws when the maximum length leaves no room before the instance", () => {
  expect(() =>
    generatedPhysicalName(scope, "role", "1a2b3c4d", { maxLength: 9 }, {}),
  ).toThrow("A maximum length of 9 leaves no room for a generated name");
});

it("leaves a param that has physicalName out of the config type", async () => {
  const Role = resource<{
    Key: { RoleName: string };
    CreateParams: { RoleName: string; Path: string };
    UpdateParams: { RoleName: string };
    ReadResult: {};
  }>({ type: "test/physical-name/role", provider: "test" })
    .defineSchema({
      RoleName: {
        propertyType: "param",
        presence: "required",
        value: string(),
        primaryKey: true,
        physicalName: { maxLength: 64 },
      },
      Path: {
        propertyType: "param",
        presence: "required",
        value: string(),
        immutable: true,
      },
    })
    .defineOperations({
      // The params of an operation always hold the name.
      create: async (params) => void (params.RoleName satisfies string),
      delete: async () => undefined,
    });

  const generated = new Role("generated", { config: { Path: "/" } });
  // @ts-expect-error RoleName has physicalName, so config cannot set it
  new Role("provided", { config: { Path: "/", RoleName: "role" } });
  // @ts-expect-error Path has no physicalName, so config must set it
  new Role("incomplete", { config: {} });

  expect(await generated.getParams()).toEqual({ Path: "/" });
});
