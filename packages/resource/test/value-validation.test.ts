import { describe, expect, expectTypeOf, it } from "vitest";
import {
  SchemaStructureError,
  ValueValidationError,
  assertComputedFields,
  assertRequiredOutputs,
  collectResourceGraph,
  resource,
  validateValues,
  withoutDeclarationChecks,
  type StandardSchemaV1,
} from "src";
import { async, check, number, string } from "./validators";

type RoleApi = {
  Key: { RoleName: string };
  CreateParams: { RoleName: string; MaxSessionDuration?: number };
  UpdateParams: { MaxSessionDuration?: number };
  ReadResult: { Arn: string };
};

const operations = {
  create: async () => undefined,
  update: async () => undefined,
  delete: async () => undefined,
};

const Role = resource<RoleApi>({ type: "test/validation/role" })
  .defineSchema({
    RoleName: {
      propertyType: "param",
      presence: "required",
      value: string(),
      primaryKey: true,
      immutable: true,
    },
    MaxSessionDuration: {
      propertyType: "param",
      presence: "optional",
      value: number(),
    },
    Arn: { propertyType: "computed", presence: "required", value: string() },
  })
  .defineOperations(operations);

describe("schema item types", () => {
  it("rejects a validator whose output is not the API's type", () => {
    resource<RoleApi>({ type: "test/validation/wrong" }).defineSchema({
      RoleName: {
        propertyType: "param",
        presence: "required",
        value: string(),
        primaryKey: true,
        immutable: true,
      },
      // @ts-expect-error string is not number
      MaxSessionDuration: {
        propertyType: "param",
        presence: "optional",
        value: string(),
      },
      Arn: { propertyType: "computed", presence: "required", value: string() },
    });
  });

  it("rejects a validator that transforms its input", () => {
    const parseNumber: StandardSchemaV1<string, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => ({ value: Number(value) }),
      },
    };
    resource<RoleApi>({ type: "test/validation/transform" }).defineSchema({
      RoleName: {
        propertyType: "param",
        presence: "required",
        value: string(),
        primaryKey: true,
        immutable: true,
      },
      // @ts-expect-error the input type string is not number
      MaxSessionDuration: {
        propertyType: "param",
        presence: "optional",
        value: parseNumber,
      },
      Arn: { propertyType: "computed", presence: "required", value: string() },
    });
  });

  it("requires a validator on every item", () => {
    resource<RoleApi>({ type: "test/validation/missing" }).defineSchema({
      RoleName: {
        propertyType: "param",
        presence: "required",
        value: string(),
        primaryKey: true,
        immutable: true,
      },
      // @ts-expect-error value is missing
      MaxSessionDuration: { propertyType: "param", presence: "optional" },
      Arn: { propertyType: "computed", presence: "required", value: string() },
    });
  });

  it("types a field by a narrower validator's output", () => {
    const Narrow = resource<RoleApi>({ type: "test/validation/narrow" })
      .defineSchema({
        RoleName: {
          propertyType: "param",
          presence: "required",
          value: check<"orders" | "billing">(
            (value) => value === "orders" || value === "billing",
            "Expected a known role",
          ),
          primaryKey: true,
          immutable: true,
        },
        Arn: {
          propertyType: "computed",
          presence: "required",
          value: string(),
        },
      })
      .defineOperations(operations);

    const role = new Narrow("role", { config: { RoleName: "orders" } });
    expectTypeOf(role.config.RoleName).toEqualTypeOf<"orders" | "billing">();
    expect(
      () =>
        // @ts-expect-error not one of the validator's outputs
        new Narrow("other", { config: { RoleName: "other" } }),
    ).toThrow(ValueValidationError);
  });
});

describe("validation at declaration", () => {
  it("throws for an invalid config value, naming the resource, field and call site", () => {
    const error = catchError(
      () =>
        new Role("orders-role", {
          config: { RoleName: "orders", MaxSessionDuration: Number(undefined) },
        }),
    );

    expect(ValueValidationError.is(error)).toBe(true);
    expect(error).toMatchObject({
      resourceId: "orders-role",
      resourceType: "test/validation/role",
      field: "MaxSessionDuration",
      point: "declaration",
      issues: ["Expected a number"],
    });
    expect(error.declaredAt).toMatch(
      /^packages\/resource\/test\/value-validation\.test\.ts:\d+$/,
    );
    expect(error.message).toMatch(
      /^Invalid MaxSessionDuration for orders-role \(test\/validation\/role\) at declaration, declared at packages\/resource\/test\/value-validation\.test\.ts:\d+: Expected a number$/,
    );
  });

  it("accepts valid config and leaves out unset optional fields", () => {
    new Role("orders-role", { config: { RoleName: "orders" } });
    new Role("billing-role", {
      config: { RoleName: "billing", MaxSessionDuration: undefined },
    });
  });

  it("skips a value that holds an output value", () => {
    const source = new Role("source", {
      config: { RoleName: "source", MaxSessionDuration: 3600 },
    });
    new Role("holder", {
      config: { RoleName: source.outputValue("Arn") },
    });
  });

  it("throws for a config field that is not a param", () => {
    const error = catchError(
      () =>
        new Role("orders-role", {
          config: { RoleName: "orders", Arn: "arn:role" } as any,
        }),
    );
    expect(SchemaStructureError.is(error)).toBe(true);
    expect(error.message).toMatch(
      /^orders-role \(test\/validation\/role\), declared at .*: these fields are not params in its schema: Arn$/,
    );
  });

  it("fails collection when an async validator rejects config", async () => {
    const AsyncRole = resource<RoleApi>({ type: "test/validation/async" })
      .defineSchema({
        RoleName: {
          propertyType: "param",
          presence: "required",
          value: async(string()),
          primaryKey: true,
          immutable: true,
        },
        Arn: {
          propertyType: "computed",
          presence: "required",
          value: string(),
        },
      })
      .defineOperations(operations);

    const collected = collectResourceGraph(() => {
      new AsyncRole("role", { config: { RoleName: 7 as any } });
    });
    await expect(collected).rejects.toMatchObject({
      name: "ValueValidationError",
      field: "RoleName",
      point: "declaration",
    });
  });

  it("is skipped inside withoutDeclarationChecks", () => {
    const role = withoutDeclarationChecks(
      () =>
        new Role("restored", {
          config: { RoleName: "restored", MaxSessionDuration: "x" as any },
        }),
    );
    expect(role.config.MaxSessionDuration).toBe("x");
    expect(() => new Role("next", { config: { RoleName: 1 as any } })).toThrow(
      ValueValidationError,
    );
  });
});

describe("validation helpers", () => {
  const subject = new Role("role", { config: { RoleName: "role" } });

  it("reports every issue with its path", () => {
    const nested = {
      ...subject,
      schema: {
        ...subject.schema,
        RoleName: {
          ...subject.schema.RoleName,
          value: {
            "~standard": {
              version: 1 as const,
              vendor: "test",
              validate: () => ({
                issues: [
                  { message: "Expected a string", path: ["Tags", { key: 0 }] },
                  { message: "Too long" },
                ],
              }),
            },
          },
        },
      },
    };
    expect(() => validateValues(nested, { RoleName: {} }, "read")).toThrow(
      "The read of role (test/validation/role) returned an invalid RoleName, declared at",
    );
    expect(
      catchError(() => validateValues(nested, { RoleName: {} }, "read")).issues,
    ).toEqual(["Tags.0: Expected a string", "Too long"]);
  });

  it("checks that a create result holds only computed fields", () => {
    expect(() =>
      assertComputedFields(subject, { Arn: "arn", RoleName: "role" }),
    ).toThrow(
      "create returned fields that are not computed in its schema: RoleName",
    );
    assertComputedFields(subject, { Arn: "arn", RoleName: undefined });
  });

  it("checks that required outputs are present", () => {
    expect(() => assertRequiredOutputs(subject, { RoleName: "role" })).toThrow(
      "these required outputs are missing: Arn",
    );
    assertRequiredOutputs(subject, { RoleName: "role", Arn: "arn" });
  });
});

function catchError(run: () => unknown): any {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected an error");
}
