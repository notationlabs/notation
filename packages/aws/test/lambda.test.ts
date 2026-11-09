import { test, expect } from "vitest";
import { collectResourceGraph } from "@notation/resource";
import { lambda, type NameSafe } from "src/lambda";

const code = { type: "file", path: "src/fns/handler.fn.js" } as const;

test("resource ids and names embed the id", () => {
  const group = lambda({ id: "get-todos", code });
  expect(group.resources.map((r) => r.id).sort()).toEqual(
    [
      "lambda:get-todos",
      "lambda:get-todos:log-group",
      "lambda:get-todos:policy-attachment",
      "lambda:get-todos:role",
      "lambda:get-todos:zip",
    ].sort(),
  );
  expect(group.fn.config.FunctionName).toBe("get-todos");
});

test("the function calls the bundle's `handler` export", () => {
  const group = lambda({
    id: "todos",
    code: { type: "file", path: "dist/runtime/todos/index.mjs" },
  });
  expect(group.fn.config.Handler).toBe("index.handler");
});

test("timeout and memory are applied to the function", () => {
  const group = lambda({ id: "todos", code, timeout: 5, memory: 256 });
  expect(group.fn.config).toMatchObject({ Timeout: 5, MemorySize: 256 });
});

test("the policy's role name is known at plan before the role is deployed", async () => {
  const group = lambda({ id: "get-todos", code });
  group.policy.contribute({
    PolicyDocument: {
      Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" }],
    },
  });
  expect(await group.policy.planParams()).toMatchObject({
    RoleName: "get-todos-role",
  });
  expect(group.policy.getDependencies()).toContain(group.role);
});

test("the group is identified by the id", () => {
  const group = lambda({ id: "get-todos", code });
  expect(group.id).toBe("get-todos");
  expect(group.fn.group).toEqual({ type: "Lambda", id: "get-todos" });
});

test("the id does not depend on the code path", () => {
  const a = lambda({ id: "fn", code });
  const b = lambda({ id: "fn", code: { ...code, path: "x.js" } });
  expect(a.fn.id).toBe(b.fn.id);
});

test("mixed-case ids are accepted", () => {
  const group = lambda({ id: "todos-getTodos", code });
  expect(group.fn.id).toBe("lambda:todos-getTodos");
});

test("a missing id throws", () => {
  // @ts-expect-error id is required
  expect(() => lambda({ code })).toThrow(/lambda\(\) requires an id/);
});

test.each(["", "has space", "has.dot", "a/b", "é", "a".repeat(65)])(
  "the id %j is rejected",
  (id) => {
    expect(() => lambda({ id: id as any, code })).toThrow(
      /lambda\(\) id|requires an id/,
    );
  },
);

test("the error names the bad id", () => {
  expect(() => lambda({ id: "bad.id" as any, code })).toThrow(
    'Invalid lambda() id "bad.id"',
  );
});

test("64 characters is the limit", () => {
  expect(() => lambda({ id: "a".repeat(64) as any, code })).not.toThrow();
});

test("two lambdas with the same id in one deployment throw", async () => {
  await expect(
    collectResourceGraph(() => {
      lambda({ id: "fn", code });
      lambda({ id: "fn", code });
    }),
  ).rejects.toThrow('Duplicate lambda() id "fn"');
});

test("ids that differ only in case clash, as IAM role names ignore case", async () => {
  await expect(
    collectResourceGraph(() => {
      lambda({ id: "myFn", code });
      lambda({ id: "myfn", code });
    }),
  ).rejects.toThrow(/Duplicate lambda\(\) id "myfn": it clashes with "myFn"/);
});

test("a name that is another Lambda's id throws, and names both declarations", async () => {
  await expect(
    collectResourceGraph(() => {
      lambda({ id: "b", code });
      lambda({ id: "a", name: "b", code });
    }),
  ).rejects.toThrow(
    'lambda({ id: "b" }) and lambda({ id: "a", name: "b" }) give two Lambda functions the same AWS name, "b". Give one of them another name.',
  );
});

test("two Lambdas in different collections can have the same name", async () => {
  await collectResourceGraph(() => {
    lambda({ id: "a", name: "b", code });
  });
  await expect(
    collectResourceGraph(() => {
      lambda({ id: "b", code });
    }),
  ).resolves.toBeDefined();
});

test("distinct ids in one deployment are fine", async () => {
  const graph = await collectResourceGraph(() => {
    lambda({ id: "a", code });
    lambda({ id: "b", code });
  });
  expect(graph.resourceGroups).toHaveLength(2);
});

test("NameSafe accepts name-safe literals and rejects the rest", () => {
  const ok: NameSafe<"todos-getTodos_2"> = "todos-getTodos_2";
  expect(ok).toBe("todos-getTodos_2");

  lambda({ id: "ok_id-1", code });

  // each rejected call also throws at runtime
  // @ts-expect-error dots are not name-safe
  expect(() => lambda({ id: "bad.id", code })).toThrow();
  // @ts-expect-error spaces are not name-safe
  expect(() => lambda({ id: "bad id", code })).toThrow();
  // @ts-expect-error the empty string is not name-safe
  expect(() => lambda({ id: "", code })).toThrow();
  expect(() =>
    lambda({
      // @ts-expect-error 65 characters is too long
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      code,
    }),
  ).toThrow();

  const id: string = "fn";
  // @ts-expect-error a plain string can't be checked
  lambda({ id, code });
});

test("resources declared by the helper are reported at the caller's line", () => {
  const group = lambda({ id: "declared", code });
  for (const resource of group.resources) {
    expect(resource.declaredAt).toMatch(/(^|\/)test\/lambda\.test\.ts:\d+$/);
  }
});
