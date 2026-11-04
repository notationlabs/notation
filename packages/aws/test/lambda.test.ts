import { describe, test, expect } from "vitest";
import {
  collectResourceGraph,
  createStandIn,
  isHandlerRef,
  linkRuntimeModules,
} from "@notation/resource";
import { api, router } from "src/api-gateway";
import {
  lambda,
  type LambdaGroup,
  type NameSafe,
  type LambdaRef,
} from "src/lambda";
import { queue, type QueueGroup } from "src/sqs";

const code = { type: "file", path: "src/fns/handler.fn.js" } as const;

test("resource ids and names embed the id", () => {
  const group = lambda({ id: "get-todos", code });
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
  expect(group.fn.id).toBe("todos-getTodos");
});

test("a missing id throws", () => {
  // @ts-expect-error id is required
  expect(() => lambda({ code })).toThrow(/lambda\(\) requires an id/);
});

test.each(["", "has space", "has.dot", "a/b", "é", "a".repeat(65)])(
  "the id %j is rejected",
  (id) => {
    expect(() => lambda({ id: id as any, code })).toThrow(
      /lambda id|requires an id/,
    );
  },
);

test("the error names the bad id", () => {
  expect(() => lambda({ id: "bad.id" as any, code })).toThrow(
    'Invalid lambda id "bad.id"',
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
  ).rejects.toThrow('Duplicate lambda id "fn"');
});

test("ids that differ only in case clash, as IAM role names ignore case", async () => {
  await expect(
    collectResourceGraph(() => {
      lambda({ id: "myFn", code });
      lambda({ id: "myfn", code });
    }),
  ).rejects.toThrow(/Duplicate lambda id "myfn": it clashes with "myFn"/);
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

  // A string that isn't a literal is checked when lambda() runs.
  const id: string = "fn";
  lambda({ id, code });
  const prefix: string = "bad.";
  expect(() => lambda({ id: `${prefix}id`, code })).toThrow(
    /Invalid lambda id "bad\.id"/,
  );
});

test("resources declared by the helper are reported at the caller's line", () => {
  const group = lambda({ id: "declared", code });
  for (const resource of group.resources) {
    expect(resource.declaredAt).toMatch(/(^|\/)test\/lambda\.test\.ts:\d+$/);
  }
});

describe("a function declared in a runtime module", () => {
  test("bundles to dist/functions/<id>, and its handle makes handler references", async () => {
    let fn!: LambdaGroup;
    let handler: unknown;
    const graph = await collectResourceGraph(() => {
      fn = lambda({ id: "checkout", timeout: 5 });
      handler = fn.handle.apiRequest(() => ({ statusCode: 200 }));
      linkRuntimeModules([
        {
          module: "runtime/checkout.ts",
          standIns: {},
          exports: { createOrder: handler },
        },
      ]);
    });

    expect(fn.fn.dependencies.zipFile.config).toEqual({
      sourceFilePath: "dist/functions/checkout/index.mjs",
    });
    expect(isHandlerRef(handler)).toBe(true);
    expect(handler).toMatchObject({ kind: "api", function: fn });
    expect(graph.runtimeFunctions).toEqual([
      {
        id: "checkout",
        service: "aws/lambda",
        bundle: "dist/functions/checkout/index.mjs",
        handlers: [
          { module: "runtime/checkout.ts", export: "createOrder", kind: "api" },
        ],
      },
    ]);
  });

  test("grants go in the role's policy", async () => {
    let fn!: LambdaGroup;
    await collectResourceGraph(() => {
      const orders = queue({ name: "orders" });
      fn = lambda({ id: "checkout", grants: [orders.grant(["SendMessage"])] });
      linkRuntimeModules([
        {
          module: "runtime/checkout.ts",
          standIns: {},
          exports: { run: fn.handle.apiRequest(() => ({})) },
        },
      ]);
    });
    const params = await fn.policy.planParams();
    expect((params.PolicyDocument as any).Statement).toEqual([
      expect.objectContaining({ Action: ["sqs:SendMessage"] }),
    ]);
  });

  test("a function that runs external code has no handle", () => {
    const fn = lambda({ id: "external", code });
    expect(() => fn.handle).toThrow(
      'lambda "external" runs the external code at src/fns/handler.fn.js, so it has no handle',
    );
  });

  test("infra wires a stand-in once the runtime module is linked", async () => {
    let fn!: LambdaGroup;
    let todoApi!: ReturnType<typeof api>;
    const graph = await collectResourceGraph(() => {
      const standIn = createStandIn("runtime/checkout.ts", "createOrder");
      todoApi = api({ name: "orders-api" });
      router(todoApi).post("/orders", standIn as LambdaRef<any>);

      fn = lambda({ id: "checkout" });
      linkRuntimeModules([
        {
          module: "runtime/checkout.ts",
          standIns: { createOrder: standIn },
          exports: { createOrder: fn.handle.apiRequest(() => ({})) },
        },
      ]);
    });

    const routes = graph.resources.filter(
      (r) => r.type === "aws/apiGateway/Route",
    );
    expect(routes.map((r) => r.config.RouteKey)).toEqual(["POST /orders"]);
    todoApi.api.setOutput({ ApiId: "api-1" } as any);
    fn.role.setOutput({ Arn: "arn:role" } as any);
    fn.fn.dependencies.zipFile.setOutput({
      filePath: "checkout.zip",
      fileSha256: "sha",
    } as any);
    const env = (await fn.fn.getParams()).Environment as any;
    expect(Object.values(env.Runtime.dispatch)).toEqual([
      {
        export: "createOrder",
        match: { apiId: "api-1", routeKey: "POST /orders" },
      },
    ]);
  });

  test("infra passes a stand-in's function, its arn and grantInvoke() on before linking", async () => {
    let checkout!: LambdaGroup;
    let caller!: LambdaGroup;
    let audit!: QueueGroup;
    let orders!: QueueGroup;
    const graph = await collectResourceGraph(() => {
      const standIn = createStandIn("runtime/checkout.ts", "processOrder");
      const fn = (standIn as any).function as LambdaGroup;
      orders = queue({ name: "orders" });
      orders.consume(fn);
      audit = queue({ name: "audit" });
      caller = lambda({ id: "caller", code, grants: [fn.grantInvoke()] });
      caller.fn.contribute({
        Environment: { Variables: { CHECKOUT_ARN: fn.arn } },
      });
      fn.policy.contribute({
        PolicyDocument: { Statement: [audit.grant(["SendMessage"])] },
      });
      expect(() => fn.id).toThrow(
        /processOrder\.function isn't known yet: infra read its id/,
      );

      checkout = lambda({ id: "checkout" });
      linkRuntimeModules([
        {
          module: "runtime/checkout.ts",
          standIns: { processOrder: standIn },
          exports: { processOrder: checkout.handle.sqsEvent(async () => {}) },
        },
      ]);
    });

    const mapping = graph.resources.find(
      (r) => r.type === "aws/lambda/LambdaEventSourceMapping",
    );
    expect(mapping?.id).toBe("orders-checkout-mapping");
    expect(caller.policy.getDependencies()).toContain(checkout.fn);
    expect(caller.fn.getDependencies()).toContain(checkout.fn);
    checkout.fn.setOutput({ FunctionArn: "arn:checkout" } as any);
    const statements = (await caller.policy.getParams()).PolicyDocument
      .Statement as any[];
    expect(statements).toContainEqual({
      Effect: "Allow",
      Action: ["lambda:InvokeFunction"],
      Resource: "arn:checkout",
    });
    audit.queue.setOutput({ QueueArn: "arn:audit" } as any);
    orders.queue.setOutput({ QueueArn: "arn:orders" } as any);
    const checkoutStatements = (await checkout.policy.getParams())
      .PolicyDocument.Statement as any[];
    expect(checkoutStatements).toContainEqual({
      Effect: "Allow",
      Action: ["sqs:SendMessage"],
      Resource: "arn:audit",
    });
  });

  test("infra passes an exported lambda() result, its arn and grantInvoke() on before linking", async () => {
    let checkout!: LambdaGroup;
    let caller!: LambdaGroup;
    const graph = await collectResourceGraph(() => {
      const checkoutFn = createStandIn(
        "runtime/checkout.ts",
        "checkoutFn",
      ) as unknown as LambdaGroup;
      queue({ name: "orders" }).consume(checkoutFn);
      caller = lambda({
        id: "caller",
        code,
        grants: [checkoutFn.grantInvoke()],
      });
      caller.fn.contribute({
        Environment: { Variables: { CHECKOUT_ARN: checkoutFn.arn } },
      });
      expect(() => checkoutFn.id).toThrow(
        /checkoutFn isn't known yet: infra read its id/,
      );

      checkout = lambda({ id: "checkout" });
      linkRuntimeModules([
        {
          module: "runtime/checkout.ts",
          standIns: { checkoutFn },
          exports: {
            checkoutFn: checkout,
            processOrder: checkout.handle.sqsEvent(async () => {}),
          },
        },
      ]);
    });

    const mapping = graph.resources.find(
      (r) => r.type === "aws/lambda/LambdaEventSourceMapping",
    );
    expect(mapping?.id).toBe("orders-checkout-mapping");
    expect(caller.policy.getDependencies()).toContain(checkout.fn);
    expect(caller.fn.getDependencies()).toContain(checkout.fn);
    checkout.fn.setOutput({ FunctionArn: "arn:checkout" } as any);
    const statements = (await caller.policy.getParams()).PolicyDocument
      .Statement as any[];
    expect(statements).toContainEqual({
      Effect: "Allow",
      Action: ["lambda:InvokeFunction"],
      Resource: "arn:checkout",
    });
  });

  test("a whole read of a queue or a Lambda group delivers its outputs and id, not its config", async () => {
    let checkout!: LambdaGroup;
    let orders!: QueueGroup;
    let worker!: LambdaGroup;
    await collectResourceGraph(
      () => {
        orders = queue({ name: "orders", visibilityTimeout: 30 });
        worker = lambda({ id: "worker", code, timeout: 10 });
        checkout = lambda({ id: "checkout" });
        linkRuntimeModules(
          [
            {
              module: "runtime/checkout.ts",
              standIns: {},
              exports: { run: checkout.handle.apiRequest(() => ({})) },
            },
          ],
          { "infra/orders": { orderQueue: orders, worker } },
        );
      },
      {
        runtimeReads: () => ["infra/orders#orderQueue", "infra/orders#worker"],
      },
    );

    const outputs = (await checkout.fn.planParams()).Environment as any;
    expect(
      Object.keys(outputs.Runtime.outputs["infra/orders#orderQueue"]).sort(),
    ).toEqual(["arn", "id", "platform", "type", "url"]);
    expect(
      Object.keys(outputs.Runtime.outputs["infra/orders#worker"]).sort(),
    ).toEqual(["arn", "id", "platform", "type"]);
  });

  test("wiring a handler of the wrong kind fails, naming the infra call site", async () => {
    await expect(
      collectResourceGraph(() => {
        const standIn = createStandIn("runtime/checkout.ts", "createOrder");
        queue({ name: "orders" }).consume(standIn as LambdaRef<any>);
        const fn = lambda({ id: "checkout" });
        linkRuntimeModules([
          {
            module: "runtime/checkout.ts",
            standIns: { createOrder: standIn },
            exports: { createOrder: fn.handle.apiRequest(() => ({})) },
          },
        ]);
      }),
    ).rejects.toThrow(
      /createOrder from runtime\/checkout\.ts handles api events, but it was wired to a source of sqs events\. Infra made the call at .*test\/lambda\.test\.ts:\d+\./,
    );
  });

  test("wiring an export that isn't a handler fails", async () => {
    await expect(
      collectResourceGraph(() => {
        const standIn = createStandIn("runtime/checkout.ts", "helper");
        queue({ name: "orders" }).consume(standIn as LambdaRef<any>);
        const fn = lambda({ id: "checkout" });
        linkRuntimeModules([
          {
            module: "runtime/checkout.ts",
            standIns: { helper: standIn },
            exports: { run: fn.handle.sqsEvent(() => {}) },
          },
        ]);
      }),
    ).rejects.toThrow(
      /runtime\/checkout\.ts has no handler or function named helper\. Infra made the call at .*test\/lambda\.test\.ts:\d+\./,
    );
  });

  test("wiring an export that is neither a handler nor a function fails", async () => {
    await expect(
      collectResourceGraph(() => {
        const standIn = createStandIn("runtime/checkout.ts", "helper");
        queue({ name: "orders" }).consume(standIn as LambdaRef<any>);
        const fn = lambda({ id: "checkout" });
        linkRuntimeModules([
          {
            module: "runtime/checkout.ts",
            standIns: { helper: standIn },
            exports: { helper: () => {}, run: fn.handle.sqsEvent(() => {}) },
          },
        ]);
      }),
    ).rejects.toThrow(
      /helper\.wire is not a function\. Infra made the call at .*test\/lambda\.test\.ts:\d+\./,
    );
  });
});
