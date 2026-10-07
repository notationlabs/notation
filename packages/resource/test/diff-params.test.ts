import { describe, expect, test } from "vitest";
import { UNKNOWN_AFTER_APPLY, diffParams, type Schema } from "src";

const schema: Schema = {
  name: { propertyType: "param", presence: "required", primaryKey: true },
  region: { propertyType: "param", presence: "required", secondaryKey: true },
  path: { propertyType: "param", presence: "optional", immutable: true },
  description: { propertyType: "param", presence: "optional" },
  tags: { propertyType: "param", presence: "optional", immutable: true },
  token: { propertyType: "param", presence: "optional", volatile: true },
  secret: { propertyType: "param", presence: "optional", hidden: true },
  arn: { propertyType: "computed", presence: "required" },
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
    expect(result.patch).toEqual({ tags: { env: "prod" } });
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
