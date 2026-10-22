import { test, expect } from "vitest";
import { collectResourceGraph } from "@notation/resource";
import { lambda, type NameSafe } from "src/lambda";

const code = { type: "file", path: "src/fns/handler.fn.js" } as const;

test("resource ids and names embed the id", () => {
  const group = lambda({ id: "get-todos", handler: "getTodos", code });
  expect(group.resources.map((r) => r.id).sort()).toEqual(
    [
      "get-todos",
      "get-todos-log-group",
      "get-todos-policy",
      "get-todos-role",
      "get-todos-zip",
    ].sort(),
  );
  expect(group.fn.config.FunctionName).toBe("get-todos");
});

test("the id does not depend on the code path", () => {
  const a = lambda({ id: "fn", handler: "h", code });
  const b = lambda({ id: "fn", handler: "h", code: { ...code, path: "x.js" } });
  expect(a.fn.id).toBe(b.fn.id);
});

test("mixed-case ids, like compiled `<id>-<handler>` ids, are accepted", () => {
  const group = lambda({ id: "todos-getTodos", handler: "getTodos", code });
  expect(group.fn.id).toBe("todos-getTodos");
});

test("a missing id throws", () => {
  // @ts-expect-error id is required
  expect(() => lambda({ handler: "h", code })).toThrow(
    /lambda\(\) requires an id/,
  );
});

test.each(["", "has space", "has.dot", "a/b", "é", "a".repeat(60)])(
  "the id %j is rejected",
  (id) => {
    expect(() => lambda({ id: id as any, handler: "h", code })).toThrow(
      /lambda id|requires an id/,
    );
  },
);

test("the error names the bad id", () => {
  expect(() => lambda({ id: "bad.id" as any, handler: "h", code })).toThrow(
    'Invalid lambda id "bad.id"',
  );
});

test("59 characters is the limit", () => {
  expect(() =>
    lambda({ id: "a".repeat(59) as any, handler: "h", code }),
  ).not.toThrow();
});

test("two lambdas with the same id in one deployment throw", async () => {
  await expect(
    collectResourceGraph(() => {
      lambda({ id: "fn", handler: "a", code });
      lambda({ id: "fn", handler: "b", code });
    }),
  ).rejects.toThrow('Duplicate lambda id "fn"');
});

test("ids that differ only in case clash, as IAM role names ignore case", async () => {
  await expect(
    collectResourceGraph(() => {
      lambda({ id: "myFn", handler: "a", code });
      lambda({ id: "myfn", handler: "b", code });
    }),
  ).rejects.toThrow(/Duplicate lambda id "myfn": it clashes with "myFn"/);
});

test("distinct ids in one deployment are fine", async () => {
  const graph = await collectResourceGraph(() => {
    lambda({ id: "a", handler: "a", code });
    lambda({ id: "b", handler: "b", code });
  });
  expect(graph.resourceGroups).toHaveLength(2);
});

test("NameSafe accepts name-safe literals and rejects the rest", () => {
  const ok: NameSafe<"todos-getTodos_2"> = "todos-getTodos_2";
  expect(ok).toBe("todos-getTodos_2");

  lambda({ id: "ok_id-1", handler: "h", code });

  // each rejected call also throws at runtime
  // @ts-expect-error dots are not name-safe
  expect(() => lambda({ id: "bad.id", handler: "h", code })).toThrow();
  // @ts-expect-error spaces are not name-safe
  expect(() => lambda({ id: "bad id", handler: "h", code })).toThrow();
  // @ts-expect-error the empty string is not name-safe
  expect(() => lambda({ id: "", handler: "h", code })).toThrow();
  expect(() =>
    lambda({
      // @ts-expect-error 60 characters is too long
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      handler: "h",
      code,
    }),
  ).toThrow();

  const id: string = "fn";
  // @ts-expect-error a plain string can't be checked
  lambda({ id, handler: "h", code });
});
