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
  mergeContributions,
  resource,
  validateValues,
  type StandardSchemaV1,
} from "src";
import { async, check, number, object, string } from "./validators";

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

const Role = resource<RoleApi>({
  type: "test/validation/role",
  provider: "test",
})
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
    resource<RoleApi>({
      type: "test/validation/wrong",
      provider: "test",
    }).defineSchema({
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
    resource<RoleApi>({
      type: "test/validation/transform",
      provider: "test",
    }).defineSchema({
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
    resource<RoleApi>({
      type: "test/validation/missing",
      provider: "test",
    }).defineSchema({
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
    const Narrow = resource<RoleApi>({
      type: "test/validation/narrow",
      provider: "test",
    })
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

const AsyncRole = resource<RoleApi>({
  type: "test/validation/async",
  provider: "test",
})
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

  it("skips a value that holds an output ref", () => {
    const source = new Role("source", {
      config: { RoleName: "source", MaxSessionDuration: 3600 },
    });
    new Role("holder", {
      config: { RoleName: source.outputRef("Arn") },
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
}>({ type: "test/validation/policy-holder", provider: "test" })
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

  it("reports an invalid known value next to an output ref at declaration", () => {
    const error = catchError(
      () =>
        new PolicyHolder("holder", {
          config: {
            Name: "holder",
            Policy: {
              Resource: [source.outputRef("Arn"), "arn:known"],
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
        Policy: { Resource: [source.outputRef("Arn")], Limit: 10 },
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
    }>({ type: "test/validation/throwing", provider: "test" })
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

    new Throwing("holder", { config: { RoleName: source.outputRef("Arn") } });
    expect(() => new Throwing("bad", { config: { RoleName: "" } })).toThrow(
      ValueValidationError,
    );
  });
});

type Flags = { features: Record<string, boolean> };

// A user's schema for a document: `features` is required, and each feature
// is a boolean. A failed document also gets an issue with no path, as a
// refinement of the whole document gives.
const flags = (): StandardSchemaV1<Flags, Flags> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const { features } = value as Record<string, unknown>;
      const issues: StandardSchemaV1.Issue[] = [];
      if (typeof features !== "object" || features === null) {
        issues.push({ message: "Required", path: ["features"] });
      } else {
        for (const [key, entry] of Object.entries(features)) {
          if (typeof entry !== "boolean") {
            issues.push({
              message: "Expected a boolean",
              path: ["features", key],
            });
          }
        }
      }
      if (issues.length > 0) issues.push({ message: "Invalid document" });
      return issues.length > 0 ? { issues } : { value: value as Flags };
    },
  },
});

const Document = resource<{
  Key: { Key: string };
  CreateParams: { Key: string; Value: Record<string, unknown> };
  UpdateParams: { Value: Record<string, unknown> };
  ReadResult: {};
}>({ type: "test/validation/document", provider: "test" })
  .defineSchema({
    Key: {
      propertyType: "param",
      presence: "required",
      value: string(),
      primaryKey: true,
      immutable: true,
    },
    Value: {
      propertyType: "param",
      presence: "required",
      value: object<Record<string, unknown>>(),
      collect: mergeContributions,
    },
  })
  .defineOperations(operations);

const shortKey = () =>
  check<string>(
    (value) => typeof value === "string" && value.length <= 8,
    "Too long",
  );

describe("checks", () => {
  it("runs a check of a param that is not collected at declaration", () => {
    const error = catchError(
      () =>
        new Document("doc", {
          config: { Key: "a-long-key" },
          checks: { Key: shortKey() },
        }),
    );
    expect(error).toMatchObject({
      name: "ValueValidationError",
      field: "Key",
      point: "declaration",
      issues: ["Too long"],
    });
  });

  it("skips the check of a collected param at declaration", () => {
    new Document("doc", {
      config: { Key: "flags", Value: {} },
      checks: { Value: flags() },
    });
  });

  it("checks the merged value at plan and deploy, after the class's validator", async () => {
    const doc = new Document("doc", {
      config: { Key: "flags", Value: { features: {} } },
      checks: { Value: flags() },
    });
    doc.contribute({ Value: { features: { invoices: "yes" } } });

    const atPlan = await validateParams(
      doc,
      await doc.planParams(),
      "plan",
    ).catch((error) => error);
    expect(atPlan).toMatchObject({
      name: "ValueValidationError",
      field: "Value",
      point: "plan",
      issues: ["features.invoices: Expected a boolean", "Invalid document"],
    });
    expect(atPlan.message).toMatch(
      /^Invalid Value for doc \(test\/validation\/document\) at plan, declared at packages\/resource\/test\/value-validation\.test\.ts:\d+: features\.invoices: Expected a boolean; Invalid document$/,
    );
    await expect(
      validateParams(doc, await doc.getParams(), "deploy"),
    ).rejects.toMatchObject({ field: "Value", point: "deploy" });
    // The class's validator fails first, so its issue is the one reported.
    await expect(
      validateParams(doc, { Key: "flags", Value: "text" }, "deploy"),
    ).rejects.toMatchObject({ issues: ["Expected an object"] });
  });

  it("accepts a value that passes the check", async () => {
    const doc = new Document("doc", {
      config: { Key: "flags" },
      checks: { Value: flags() },
    });
    doc.contribute({ Value: { features: { invoices: true } } });
    doc.contribute({ Value: { features: { uploads: true } } });
    await validateParams(doc, await doc.getParams(), "deploy");
  });

  it("drops the issues at, inside and above an unknown value", async () => {
    const doc = new Document("doc", {
      config: { Key: "flags" },
      checks: { Value: flags() },
    });
    await validateParams(
      doc,
      { Key: "flags", Value: { features: UNKNOWN_AFTER_APPLY } },
      "plan",
    );
    await expect(
      validateParams(
        doc,
        {
          Key: "flags",
          Value: { features: { uploads: UNKNOWN_AFTER_APPLY, invoices: 1 } },
        },
        "plan",
      ),
    ).rejects.toMatchObject({
      issues: ["features.invoices: Expected a boolean"],
    });
  });

  it("does not run on partial params", async () => {
    const doc = new Document("doc", {
      config: { Key: "flags" },
      checks: { Value: flags() },
    });
    await validateParams(doc, { Key: "flags", Value: {} }, "deploy", {
      partial: true,
    });
    await expect(
      validateParams(doc, { Key: "flags", Value: "text" }, "deploy", {
        partial: true,
      }),
    ).rejects.toMatchObject({ issues: ["Expected an object"] });
  });

  it("does not run on the result of a read, create or rotate", () => {
    const doc = new Document("doc", {
      config: { Key: "flags" },
      checks: { Value: flags() },
    });
    for (const point of ["read", "create", "rotate"] as const) {
      validateValues(doc, { Value: {} }, point);
    }
  });

  it("rejects a check that names a field that is not a param", () => {
    const error = catchError(
      () =>
        new Role("role", {
          config: { RoleName: "role" },
          // @ts-expect-error Arn is not a param
          checks: { Arn: string() },
        }),
    );
    expect(SchemaStructureError.is(error)).toBe(true);
    expect(error.message).toMatch(
      /these checks name fields that are not params in its schema: Arn$/,
    );
  });

  it("fails collection when an async check rejects config", async () => {
    const collected = collectResourceGraph(() => {
      new Document("doc", {
        config: { Key: "a-long-key" },
        checks: { Key: async(shortKey()) },
      });
    });
    await expect(collected).rejects.toMatchObject({
      name: "ValueValidationError",
      field: "Key",
      point: "declaration",
    });
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
