import { expect, it } from "vitest";
import {
  collectResourceGraph,
  createHandlerRef,
  createStandIn,
  declareRuntimeFunction,
  isHandlerRef,
  isStandIn,
  linkRuntimeModules,
  onEvaluationEnd,
  resolveRuntimeTarget,
  type HandlerRef,
} from "src";

class Fn {
  constructor(readonly id: string) {}
  describe() {
    return `fn ${this.id}`;
  }
}

function declare(id: string) {
  const fn = new Fn(id);
  declareRuntimeFunction(
    fn,
    { id, service: "test/fn", bundle: `dist/functions/${id}/index.mjs` },
    declare,
  );
  const handle = (kind: string) =>
    function make() {
      return createHandlerRef(kind, fn, make);
    };
  return { fn, api: handle("api"), sqs: handle("sqs") };
}

it("links stand-ins to the exports of the runtime module and lists each function's handlers", async () => {
  let wired: unknown;
  const graph = await collectResourceGraph(() => {
    const standIns = {
      createOrder: createStandIn("runtime/checkout.ts", "createOrder"),
      processOrder: createStandIn("runtime/checkout.ts", "processOrder"),
    };
    onEvaluationEnd(() => {
      wired = resolveRuntimeTarget(standIns.processOrder);
    });

    const checkout = declare("checkout");
    const exports = {
      createOrder: checkout.api(),
      processOrder: checkout.sqs(),
    };
    linkRuntimeModules([{ module: "runtime/checkout.ts", standIns, exports }]);
    expect(resolveRuntimeTarget(standIns.createOrder)).toBe(
      exports.createOrder,
    );
    expect((standIns.createOrder as HandlerRef).kind).toBe("api");
    expect((standIns.createOrder as any).function.describe()).toBe(
      "fn checkout",
    );
  });

  expect(isHandlerRef(wired)).toBe(true);
  expect((wired as HandlerRef).export).toBe("processOrder");
  expect(graph.runtimeFunctions).toEqual([
    {
      id: "checkout",
      service: "test/fn",
      bundle: "dist/functions/checkout/index.mjs",
      handlers: [
        { module: "runtime/checkout.ts", export: "createOrder", kind: "api" },
        { module: "runtime/checkout.ts", export: "processOrder", kind: "sqs" },
      ],
    },
  ]);
});

it("fails when infra reads a stand-in before it is linked, naming the call site", async () => {
  await collectResourceGraph(() => {
    const standIn = createStandIn("runtime/checkout.ts", "createOrder");
    expect(isStandIn(standIn)).toBe(true);
    expect(() => (standIn as any).kind).toThrow(
      /createOrder isn't known yet: infra read kind on it while infra was being evaluated \(.*runtime-link\.test\.ts:\d+\)/,
    );
    const fn = (standIn as any).function;
    expect(() => fn.id).toThrow(
      /createOrder\.function isn't known yet: infra used it as a value while infra was being evaluated/,
    );
    expect(() => resolveRuntimeTarget(standIn)).toThrow("isn't linked yet");

    const checkout = declare("checkout");
    linkRuntimeModules([
      {
        module: "runtime/checkout.ts",
        standIns: { createOrder: standIn },
        exports: { createOrder: checkout.api() },
      },
    ]);
    expect(fn.id).toBe("checkout");
    expect(resolveRuntimeTarget(fn)).toBe(checkout.fn);
  });
});

it("links an exported function to the function itself", async () => {
  await collectResourceGraph(() => {
    const standIn = createStandIn("runtime/checkout.ts", "checkoutFn");
    const checkout = declare("checkout");
    linkRuntimeModules([
      {
        module: "runtime/checkout.ts",
        standIns: { checkoutFn: standIn },
        exports: { checkoutFn: checkout.fn, createOrder: checkout.api() },
      },
    ]);
    expect(resolveRuntimeTarget(standIn)).toBe(checkout.fn);
    expect((standIn as any).describe()).toBe("fn checkout");
  });
});

it("fails when a handler isn't exported, naming the handle call", async () => {
  await expect(
    collectResourceGraph(() => {
      const checkout = declare("checkout");
      checkout.api();
      linkRuntimeModules([
        { module: "runtime/checkout.ts", standIns: {}, exports: {} },
      ]);
    }),
  ).rejects.toThrow(
    /The api handler made at .*runtime-link\.test\.ts:\d+ isn't exported from a runtime module/,
  );
});

it("fails when a function has no handlers", async () => {
  await expect(
    collectResourceGraph(() => {
      declare("checkout");
      linkRuntimeModules([]);
    }),
  ).rejects.toThrow(/The function "checkout" declared at .* has no handlers/);
});

it("fails when two modules export handlers of one function under the same name", async () => {
  await expect(
    collectResourceGraph(() => {
      const shared = declare("shared");
      linkRuntimeModules([
        {
          module: "runtime/a.ts",
          standIns: {},
          exports: { run: shared.api() },
        },
        {
          module: "runtime/b.ts",
          standIns: {},
          exports: { run: shared.api() },
        },
      ]);
    }),
  ).rejects.toThrow(
    'The function "shared" has two handlers named run, exported from runtime/a.ts and runtime/b.ts',
  );
});

it("names a handler exported under several names after the first", async () => {
  await collectResourceGraph(() => {
    const checkout = declare("checkout");
    const handler = checkout.api();
    linkRuntimeModules([
      {
        module: "runtime/b.ts",
        standIns: {},
        exports: { alias: handler },
      },
      {
        module: "runtime/a.ts",
        standIns: {},
        exports: { zeta: handler, beta: handler },
      },
    ]);
    expect(handler.module).toBe("runtime/a.ts");
    expect(handler.export).toBe("beta");
  });
});
