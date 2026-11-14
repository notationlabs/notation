import { describe, expect, test } from "vitest";
import {
  UNKNOWN_AFTER_APPLY,
  backfillParams,
  diffParams,
  type Schema,
} from "src";
import { object, string } from "./validators";

const schema: Schema = {
  name: {
    propertyType: "param",
    presence: "required",
    value: string(),
    primaryKey: true,
  },
  region: {
    propertyType: "param",
    presence: "required",
    value: string(),
    secondaryKey: true,
  },
  path: {
    propertyType: "param",
    presence: "optional",
    value: string(),
    immutable: true,
  },
  description: { propertyType: "param", presence: "optional", value: string() },
  tags: {
    propertyType: "param",
    presence: "optional",
    value: object<Record<string, string>>(),
    immutable: true,
  },
  token: {
    propertyType: "param",
    presence: "optional",
    value: string(),
    volatile: true,
  },
  secret: {
    propertyType: "param",
    presence: "optional",
    value: string(),
    hidden: true,
  },
  arn: { propertyType: "computed", presence: "required", value: string() },
};

const previous = {
  name: "role",
  region: "eu-west-2",
  path: "/",
  description: "before",
  tags: { team: "a", env: "dev" },
  token: "t1",
  secret: "s1",
  arn: "arn:1",
};

describe("diffParams", () => {
  test("reports no change for equal params", () => {
    expect(diffParams(schema, previous, previous, { canUpdate: true })).toEqual(
      {
        patch: {},
        changed: [],
        replaceFields: [],
        diff: { added: {}, deleted: {}, updated: {} },
      },
    );
  });

  // State written by an earlier version can hold a param that the schema has
  // since dropped.
  test("ignores a stored param that is not in the schema", () => {
    expect(
      diffParams(schema, { ...previous, removed: 1 }, previous, {
        canUpdate: true,
      }),
    ).toMatchObject({ patch: {}, changed: [], replaceFields: [] });
  });

  test("updates a mutable param in place", () => {
    const result = diffParams(
      schema,
      previous,
      { ...previous, description: "after" },
      { canUpdate: true },
    );
    expect(result).toMatchObject({
      patch: { description: "after" },
      changed: ["description"],
      replaceFields: [],
      diff: { updated: { description: "after" } },
    });
  });

  test("replaces on a change to an immutable param", () => {
    const result = diffParams(
      schema,
      previous,
      { ...previous, path: "/service/", description: "after" },
      { canUpdate: true },
    );
    expect(result.changed).toEqual(["path", "description"]);
    expect(result.replaceFields).toEqual([{ name: "path", known: true }]);
  });

  test("replaces on a change to a primary or secondary key", () => {
    expect(
      diffParams(
        schema,
        previous,
        { ...previous, name: "role-2", region: "us-east-1" },
        { canUpdate: true },
      ).replaceFields,
    ).toEqual([
      { name: "name", known: true },
      { name: "region", known: true },
    ]);
  });

  test("replaces on a change anywhere inside an immutable param", () => {
    const result = diffParams(
      schema,
      previous,
      { ...previous, tags: { team: "a", env: "prod" } },
      { canUpdate: true },
    );
    expect(result.patch).toEqual({ tags: { team: "a", env: "prod" } });
    expect(result.replaceFields).toEqual([{ name: "tags", known: true }]);
  });

  test("replaces on any change when the resource cannot update", () => {
    expect(
      diffParams(
        schema,
        previous,
        { ...previous, description: "after" },
        { canUpdate: false },
      ).replaceFields,
    ).toEqual([{ name: "description", known: true }]);
  });

  test("ignores volatile, hidden and computed fields", () => {
    expect(
      diffParams(
        schema,
        previous,
        { ...previous, token: "t2", secret: "s2", arn: "arn:2" },
        { canUpdate: false },
      ).changed,
    ).toEqual([]);
  });

  test("reports a removed param as changed", () => {
    const { path: _, ...desired } = previous;
    expect(
      diffParams(schema, previous, desired, { canUpdate: true }),
    ).toMatchObject({
      changed: ["path"],
      replaceFields: [{ name: "path", known: true }],
      diff: { deleted: { path: null } },
    });
  });

  test("treats an undefined param as absent", () => {
    const { path: _, ...stored } = previous;
    expect(
      diffParams(
        schema,
        JSON.parse(JSON.stringify(stored)),
        { ...stored, path: undefined },
        { canUpdate: true },
      ).changed,
    ).toEqual([]);
  });

  test("marks an unknown immutable or key param as possibly forcing replacement", () => {
    const result = diffParams(
      schema,
      previous,
      {
        ...previous,
        name: UNKNOWN_AFTER_APPLY,
        description: UNKNOWN_AFTER_APPLY,
      },
      { canUpdate: true },
    );
    expect(result.changed).toEqual(["name", "description"]);
    expect(result.replaceFields).toEqual([{ name: "name", known: false }]);
  });

  test("recognises an unknown value after a JSON round trip", () => {
    const desired = JSON.parse(
      JSON.stringify({ ...previous, path: UNKNOWN_AFTER_APPLY }),
    );
    expect(
      diffParams(schema, previous, desired, { canUpdate: true }).replaceFields,
    ).toEqual([{ name: "path", known: false }]);
  });
});

describe("backfillParams", () => {
  const added: Schema = {
    name: {
      propertyType: "param",
      presence: "required",
      value: string(),
      primaryKey: true,
    },
    target: {
      propertyType: "param",
      presence: "required",
      value: string(),
      immutable: true,
      backfill: (recorded) => `target of ${recorded.name}`,
    },
  };

  test("fills in a param that the record doesn't hold", () => {
    const recorded = { name: "a" };
    expect(backfillParams(added, recorded)).toEqual({
      name: "a",
      target: "target of a",
    });
    expect(recorded).toEqual({ name: "a" });
  });

  test("keeps a param that the record holds", () => {
    const recorded = { name: "a", target: "b" };
    expect(backfillParams(added, recorded)).toBe(recorded);
  });
});
