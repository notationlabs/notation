import { expect, it } from "vitest";
import {
  collectResourceGraph,
  createHandlerRef,
  createStandIn,
  declareRuntimeFunction,
  isHandlerRef,
  isStandIn,
  linkRuntimeModules,
  OutputValue,
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

class Queue {
  readonly id = "orders";
  readonly config = { name: "orders" };
  readonly url = new OutputValue({} as any, ["QueueUrl"]);
  readonly arn = new OutputValue({} as any, ["QueueArn"]);
  readonly queue = new Fn("orders-queue");
  grant() {
    return {};
  }
}

const collectReads = async (reads: string[]) => {
  let delivered: Record<string, unknown> | undefined;
  const infra = { orderQueue: new Queue(), settings: { memory: 64 } };
  await collectResourceGraph(
    () => {
      const fn = new Fn("checkout");
      declareRuntimeFunction(
        fn,
        {
          id: "checkout",
          service: "test/fn",
          bundle: "dist/functions/checkout/index.mjs",
        },
        collectReads,
        (values) => {
          delivered = values;
        },
      );
      linkRuntimeModules(
        [
          {
            module: "runtime/checkout.ts",
            standIns: {},
            exports: { run: createHandlerRef("api", fn, collectReads) },
          },
        ],
        { "infra/orders": infra },
      );
    },
    { runtimeReads: () => reads },
  );
  return { delivered, infra };
};

it("delivers the values that a function reads from infra", async () => {
  const { delivered, infra } = await collectReads([
    "infra/orders#orderQueue.url",
    "infra/orders#orderQueue.url.length",
    "infra/orders#settings",
    "infra/orders#settings.memory",
  ]);
  expect(delivered).toEqual({
    "infra/orders#orderQueue.url": infra.orderQueue.url,
    "infra/orders#settings": { memory: 64 },
  });
});

it("delivers the data properties of a whole binding", async () => {
  const { delivered, infra } = await collectReads(["infra/orders#orderQueue"]);
  expect(delivered).toEqual({
    "infra/orders#orderQueue": {
      id: "orders",
      config: { name: "orders" },
      url: infra.orderQueue.url,
      arn: infra.orderQueue.arn,
    },
  });
});

it("fails when a function reads an infra function, or a value that isn't data", async () => {
  await expect(collectReads(["infra/orders#orderQueue.grant"])).rejects.toThrow(
    'The function "checkout" reads infra/orders#orderQueue.grant, which is a function of infra. Runtime code can\'t call or store infra functions',
  );
  await expect(collectReads(["infra/orders#orderQueue.queue"])).rejects.toThrow(
    'The function "checkout" reads infra/orders#orderQueue.queue, which is not an output value or data',
  );
  await expect(collectReads(["infra/orders#missing"])).rejects.toThrow(
    "infra/orders has no export named missing",
  );
  await expect(collectReads(["infra/other#x"])).rejects.toThrow(
    "the infra phase didn't load infra/other",
  );
});
