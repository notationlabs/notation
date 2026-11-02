import { describe, expect, expectTypeOf, it } from "vitest";
import {
  SchemaStructureError,
  ValueValidationError,
  assertComputedFields,
  assertRequiredOutputs,
  validateParams,
  UNKNOWN_AFTER_APPLY,
  collectResourceGraph,
  isUnknownAfterApply,
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

const AsyncRole = resource<RoleApi>({ type: "test/validation/async" })
  .defineSchema({
    RoleName: {
      propertyType: "param",
      presence: "required",
      value: async(string()),
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
      /^Invalid MaxSessionDuration for orders-role \(test\/validation\/role\) when declared at packages\/resource\/test\/value-validation\.test\.ts:\d+: Expected a number$/,
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
    const collected = collectResourceGraph(() => {
      new AsyncRole("role", { config: { RoleName: 7 as any } });
    });
    await expect(collected).rejects.toMatchObject({
      name: "ValueValidationError",
      field: "RoleName",
      point: "declaration",
    });
  });

  it("does not leave a rejection unhandled while evaluation runs", async () => {
    const unhandled = watchUnhandledRejections();
    try {
      const collected = collectResourceGraph(async () => {
        new AsyncRole("role", { config: { RoleName: 7 as any } });
        await wait(20);
      });
      await expect(collected).rejects.toMatchObject({
        name: "ValueValidationError",
        field: "RoleName",
      });
      await wait(0);
    } finally {
      unhandled.stop();
    }
    expect(unhandled.reasons).toEqual([]);
  });

  it("does not leave an async check unhandled when a sync check throws", async () => {
    const unhandled = watchUnhandledRejections();
    try {
      expect(
        () =>
          new AsyncRole("role", {
            config: { RoleName: 7 as any, MaxSessionDuration: "x" as any },
          }),
      ).toThrow(ValueValidationError);
      await wait(20);
    } finally {
      unhandled.stop();
    }
    expect(unhandled.reasons).toEqual([]);
  });

  it("is skipped when collection turns declaration checks off", async () => {
    await collectResourceGraph(
      () => {
        new Role("restored", { config: { RoleName: 1 as any } });
        new AsyncRole("async", { config: { RoleName: 7 as any } });
      },
      { declarationChecks: false },
    );
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

type Policy = { Resource: string[]; Limit: number };

// Reports an issue at each invalid entry, and also at the parents of the
// entry, as a union or object check does.
const policy = (): StandardSchemaV1<Policy, Policy> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const { Resource, Limit } = value as Record<string, unknown>;
      const issues: StandardSchemaV1.Issue[] = [];
      (Resource as unknown[]).forEach((entry, index) => {
        if (typeof entry !== "string") {
          issues.push({
            message: "Expected a string",
            path: ["Resource", index],
          });
        }
      });
      if (issues.length > 0) {
        issues.push({ message: "Invalid resources", path: ["Resource"] });
      }
      if (typeof Limit !== "number") {
        issues.push({ message: "Expected a number", path: ["Limit"] });
      }
      if (issues.length > 0) issues.push({ message: "Invalid policy" });
      return issues.length > 0 ? { issues } : { value: value as Policy };
    },
  },
});

const PolicyHolder = resource<{
  Key: { Name: string };
  CreateParams: { Name: string; Policy?: Policy };
  UpdateParams: { Policy?: Policy };
  ReadResult: {};
}>({ type: "test/validation/policy-holder" })
  .defineSchema({
    Name: {
      propertyType: "param",
      presence: "required",
      value: string(),
      primaryKey: true,
      immutable: true,
    },
    Policy: { propertyType: "param", presence: "optional", value: policy() },
  })
  .defineOperations(operations);

describe("values that hold unknowns", () => {
  const source = new Role("source", { config: { RoleName: "source" } });

  it("reports an invalid known value next to an output value at declaration", () => {
    const error = catchError(
      () =>
        new PolicyHolder("holder", {
          config: {
            Name: "holder",
            Policy: {
              Resource: [source.outputValue("Arn"), "arn:known"],
              Limit: "ten" as any,
            },
          },
        }),
    );

    expect(error).toMatchObject({
      name: "ValueValidationError",
      field: "Policy",
      point: "declaration",
      issues: ["Limit: Expected a number"],
    });
  });

  it("drops issues at, inside and above an unknown value", () => {
    new PolicyHolder("holder", {
      config: {
        Name: "holder",
        Policy: { Resource: [source.outputValue("Arn")], Limit: 10 },
      },
    });
    expect(() =>
      validateValues(
        new PolicyHolder("checked", { config: { Name: "checked" } }),
        {
          Policy: {
            Resource: [UNKNOWN_AFTER_APPLY, "arn:known"],
            Limit: 10,
          },
        },
        "plan",
        isUnknownAfterApply,
      ),
    ).not.toThrow();
    expect(
      catchError(() =>
        validateValues(
          new PolicyHolder("mixed", { config: { Name: "mixed" } }),
          { Policy: { Resource: [UNKNOWN_AFTER_APPLY, 5], Limit: 10 } },
          "plan",
          isUnknownAfterApply,
        ),
      ).issues,
    ).toEqual(["Resource.1: Expected a string"]);
  });

  it("treats a validator that throws on an unknown value as passing", () => {
    const Throwing = resource<{
      Key: { RoleName: string };
      CreateParams: { RoleName: string };
      UpdateParams: {};
      ReadResult: {};
    }>({ type: "test/validation/throwing" })
      .defineSchema({
        RoleName: {
          propertyType: "param",
          presence: "required",
          value: check<string>((value) => String(value) !== "", "Empty"),
          primaryKey: true,
          immutable: true,
        },
      })
      .defineOperations(operations);

    new Throwing("holder", { config: { RoleName: source.outputValue("Arn") } });
    expect(() => new Throwing("bad", { config: { RoleName: "" } })).toThrow(
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

  it("leaves the validator's messages out for a sensitive field", () => {
    const sensitive = {
      ...subject,
      schema: {
        ...subject.schema,
        RoleName: {
          ...subject.schema.RoleName,
          sensitive: true as const,
          value: {
            "~standard": {
              version: 1 as const,
              vendor: "test",
              validate: (value: unknown) => ({
                issues: [{ message: `Too long: ${value}`, path: ["Secret"] }],
              }),
            },
          },
        },
      },
    };
    const error = catchError(() =>
      validateValues(sensitive, { RoleName: "hunter2" }, "plan"),
    );
    expect(error.issues).toEqual(["Secret: Invalid sensitive value"]);
    expect(error.message).not.toContain("hunter2");
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

  it("checks that required params are present at plan and deploy", async () => {
    await expect(
      validateParams(subject, { MaxSessionDuration: 3600 }, "plan"),
    ).rejects.toThrow("these required params are missing: RoleName");
    await expect(
      validateParams(subject, { RoleName: undefined }, "deploy"),
    ).rejects.toThrow("these required params are missing: RoleName");
    await validateParams(subject, { RoleName: UNKNOWN_AFTER_APPLY }, "plan");
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

// The package has no Node types, so the globals are reached untyped.
const node = globalThis as any;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => node.setTimeout(resolve, ms));
}

function watchUnhandledRejections() {
  const reasons: unknown[] = [];
  const listener = (reason: unknown) => reasons.push(reason);
  node.process.on("unhandledRejection", listener);
  return {
    reasons,
    stop: () => node.process.off("unhandledRejection", listener),
  };
}
