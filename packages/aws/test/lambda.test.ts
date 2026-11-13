import { test, expect } from "vitest";
import { UNKNOWN_AFTER_APPLY, collectResourceGraph } from "@notation/resource";
import { lambda, type NameSafe } from "src/lambda";

const code = { type: "file", path: "src/fns/handler.fn.js" } as const;

test("resource ids embed the id", () => {
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

test("concurrency adds a reserved concurrency that depends on the function", () => {
  const group = lambda({ id: "todos", code, concurrency: 0 });
  const concurrency = group.resources.find(
    (r) => r.id === "lambda:todos:concurrency",
  );
  expect(concurrency?.config).toEqual({ ReservedConcurrentExecutions: 0 });
  expect(concurrency?.dependencies).toEqual({ lambda: group.fn });
});

test("a function without concurrency has no reserved concurrency", () => {
  const group = lambda({ id: "todos", code });
  expect(
    group.resources.find((r) => r.id === "lambda:todos:concurrency"),
  ).toBeUndefined();
});

test("the policy's role name is unknown at plan before the role is deployed", async () => {
  const group = lambda({ id: "get-todos", code });
  group.policy.contribute({
    PolicyDocument: {
      Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" }],
    },
  });
  expect(await group.policy.planParams()).toMatchObject({
    RoleName: UNKNOWN_AFTER_APPLY,
  });
  group.role.setOutput({ RoleName: "get-todos-role-1a2b3c4d" } as any);
  expect(await group.policy.planParams()).toMatchObject({
    RoleName: "get-todos-role-1a2b3c4d",
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

test("ids that differ only in case do not clash", async () => {
  const graph = await collectResourceGraph(() => {
    lambda({ id: "myFn", code });
    lambda({ id: "myfn", code });
  });

  expect(graph.resourceGroups.map((group) => group.id)).toEqual([
    "myFn",
    "myfn",
  ]);
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
