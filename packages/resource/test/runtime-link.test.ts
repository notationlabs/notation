import { expect, it } from "vitest";
import {
  captureCallSite,
  collectResourceGraph,
  createHandlerRef,
  createStandIn,
  declareRuntimeFunction,
  isHandlerRef,
  isStandIn,
  linkRuntimeModules,
  OutputValue,
  onEvaluationEnd,
  resolveDeferred,
  resolveRuntimeTarget,
  resource,
  type HandlerRef,
} from "src";
import { check, string } from "./validators";

class Fn {
  constructor(readonly id: string) {}
  describe() {
    return `fn ${this.id}`;
  }
}

// `file:line` of the line after the one that calls this.
function nextLine(): string {
  const [, file, line] = captureCallSite(nextLine)!.match(/^(.*):(\d+)$/)!;
  return `${file}:${Number(line) + 1}`;
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

it("fails when infra reads a stand-in's identity before it is linked, naming the call site", async () => {
  await collectResourceGraph(() => {
    const standIn = createStandIn("runtime/checkout.ts", "createOrder");
    expect(isStandIn(standIn)).toBe(true);
    expect(() => (standIn as any).id).toThrow(
      /createOrder isn't known yet: infra read its id while infra was being evaluated \(.*runtime-link\.test\.ts:\d+\)/,
    );
    expect(() => `${standIn}`).toThrow(
      /createOrder isn't known yet: infra turned it into a string while infra was being evaluated \(.*runtime-link\.test\.ts:\d+\)/,
    );
    const fn = (standIn as any).function;
    expect(() => fn.id).toThrow(
      /createOrder\.function isn't known yet: infra read its id while infra was being evaluated \(.*runtime-link\.test\.ts:\d+\)/,
    );
    expect(() => `${fn.arn}`).toThrow(
      /createOrder\.function\.arn isn't known yet: infra turned it into a string while infra was being evaluated \(.*runtime-link\.test\.ts:\d+\)/,
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

const FnResource = resource<{
  Key: { name: string };
  CreateParams: { name: string };
  UpdateParams: {};
  ReadResult: { arn: string };
}>({ type: "test/runtime-link/function" })
  .defineSchema({
    name: {
      propertyType: "param",
      presence: "required",
      value: string(),
      primaryKey: true,
      immutable: true,
    },
    arn: { propertyType: "computed", presence: "required", value: string() },
  })
  .defineOperations({
    create: async () => undefined,
    delete: async () => undefined,
  });

type Statement = { Action: string; Resource: string };

const Policy = resource<{
  Key: { name: string };
  CreateParams: { name: string; target?: string; statements: Statement[] };
  UpdateParams: { target?: string; statements: Statement[] };
  ReadResult: {};
}>({ type: "test/runtime-link/policy" })
  .defineSchema({
    name: {
      propertyType: "param",
      presence: "required",
      value: string(),
      primaryKey: true,
      immutable: true,
    },
    target: {
      propertyType: "param",
      presence: "optional",
      value: check<string | undefined>(
        (value) => value === undefined || typeof value === "string",
        "Expected a string",
      ),
    },
    statements: {
      propertyType: "param",
      presence: "required",
      value: check<Statement[]>(Array.isArray, "Expected an array"),
      collect: (items: any[]) => items.flat(),
    },
  })
  .defineOperations({
    create: async () => undefined,
    update: async () => undefined,
    delete: async () => undefined,
  });

class ResourceFn {
  readonly resource = new FnResource("checkout", {
    config: { name: "checkout" },
  });
  readonly arn = this.resource.outputValue("arn");
  grantInvoke(): Statement {
    return { Action: "invoke", Resource: this.arn };
  }
}

it("resolves values read from a stand-in's function in config and contributions once linked", async () => {
  let policy!: InstanceType<typeof Policy>;
  let fn!: ResourceFn;
  await collectResourceGraph(() => {
    const standIn = createStandIn("runtime/checkout.ts", "createOrder");
    const lazy = (standIn as any).function;
    policy = new Policy("policy", {
      config: { name: "policy", target: lazy.arn },
    });
    policy.contribute({ statements: [lazy.grantInvoke()] });

    fn = new ResourceFn();
    declareRuntimeFunction(
      fn,
      { id: "checkout", service: "test/fn", bundle: "b" },
      it,
    );
    linkRuntimeModules([
      {
        module: "runtime/checkout.ts",
        standIns: { createOrder: standIn },
        exports: { createOrder: createHandlerRef("api", fn, it) },
      },
    ]);
    expect(lazy.arn).toBeInstanceOf(OutputValue);
  });

  expect(policy.getDependencies()).toEqual([fn.resource]);
  fn.resource.setOutput({ name: "checkout", arn: "arn:checkout" });
  expect(await policy.getParams()).toEqual({
    name: "policy",
    target: "arn:checkout",
    statements: [{ Action: "invoke", Resource: "arn:checkout" }],
  });
});

it("fails when a value read from a stand-in's function is used before linking, naming where it was read", async () => {
  await expect(
    collectResourceGraph(() => {
      const standIn = createStandIn("runtime/checkout.ts", "createOrder");
      const policy = new Policy("policy", {
        config: { name: "policy", target: (standIn as any).function.arn },
      });
      policy.getDependencies();
    }),
  ).rejects.toThrow(
    /createOrder\.function\.arn isn't known yet: infra used it at .*runtime-link\.test\.ts:\d+ before the runtime modules were linked/,
  );
});

it("resolves values read from an exported function's stand-in once linked", async () => {
  let policy!: InstanceType<typeof Policy>;
  let fn!: ResourceFn;
  await collectResourceGraph(() => {
    const standIn = createStandIn("runtime/checkout.ts", "checkoutFn");
    const kind = (standIn as any).kind;
    policy = new Policy("policy", {
      config: { name: "policy", target: (standIn as any).arn },
    });
    policy.contribute({ statements: [(standIn as any).grantInvoke()] });
    expect(() => `${(standIn as any).arn}`).toThrow(
      /checkoutFn\.arn isn't known yet: infra turned it into a string/,
    );

    fn = new ResourceFn();
    declareRuntimeFunction(
      fn,
      { id: "checkout", service: "test/fn", bundle: "b" },
      it,
    );
    linkRuntimeModules([
      {
        module: "runtime/checkout.ts",
        standIns: { checkoutFn: standIn },
        exports: { checkoutFn: fn, run: createHandlerRef("api", fn, it) },
      },
    ]);
    expect(resolveDeferred(standIn)).toBe(fn);
    expect(resolveDeferred(kind)).toBeUndefined();
  });

  expect(policy.getDependencies()).toEqual([fn.resource]);
  fn.resource.setOutput({ name: "checkout", arn: "arn:checkout" });
  expect(await policy.getParams()).toEqual({
    name: "policy",
    target: "arn:checkout",
    statements: [{ Action: "invoke", Resource: "arn:checkout" }],
  });
});

it("wires a handler's stand-in once linked, with the handler's function and export", async () => {
  const wired: Array<[unknown, string]> = [];
  await collectResourceGraph(() => {
    const standIn = createStandIn("runtime/checkout.ts", "processOrder");
    (standIn as any).wire("sqs", (fn: unknown, exportName: string) => {
      wired.push([fn, exportName]);
    });
    expect(wired).toEqual([]);

    const checkout = declare("checkout");
    linkRuntimeModules([
      {
        module: "runtime/checkout.ts",
        standIns: { processOrder: standIn },
        exports: { processOrder: checkout.sqs() },
      },
    ]);
    expect(wired).toEqual([[checkout.fn, "processOrder"]]);

    (standIn as any).wire("sqs", (fn: unknown, exportName: string) => {
      wired.push([fn, exportName]);
    });
    expect(wired).toHaveLength(2);
  });
});

it("declares the resources that a deferred call makes at infra's call site", async () => {
  let policy!: InstanceType<typeof Policy>;
  let wiredAt: string | undefined;
  await collectResourceGraph(() => {
    const standIn = createStandIn("runtime/checkout.ts", "processOrder");
    const wire = (standIn as any).wire;
    wiredAt = nextLine();
    wire("sqs", () => {
      policy = new Policy("policy", {
        config: { name: "policy", statements: [] },
      });
    });

    const checkout = declare("checkout");
    linkRuntimeModules([
      {
        module: "runtime/checkout.ts",
        standIns: { processOrder: standIn },
        exports: { processOrder: checkout.sqs() },
      },
    ]);
  });
  expect(policy.declaredAt).toBe(wiredAt);
});

it("fails when a handler is wired to a source of another kind, naming the infra call site", async () => {
  await expect(
    collectResourceGraph(() => {
      const standIn = createStandIn("runtime/checkout.ts", "createOrder");
      (standIn as any).wire("sqs", () => {});
      const checkout = declare("checkout");
      linkRuntimeModules([
        {
          module: "runtime/checkout.ts",
          standIns: { createOrder: standIn },
          exports: { createOrder: checkout.api() },
        },
      ]);
    }),
  ).rejects.toThrow(
    /createOrder from runtime\/checkout\.ts handles api events, but it was wired to a source of sqs events\. Infra made the call at .*runtime-link\.test\.ts:\d+\./,
  );
});

it("fails when a value read from a stand-in names an export that the runtime module doesn't have", async () => {
  await expect(
    collectResourceGraph(() => {
      const standIn = createStandIn("runtime/checkout.ts", "missing");
      const policy = new Policy("policy", {
        config: { name: "policy", target: (standIn as any).arn },
      });
      const checkout = declare("checkout");
      linkRuntimeModules([
        {
          module: "runtime/checkout.ts",
          standIns: { missing: standIn },
          exports: { run: checkout.api() },
        },
      ]);
      policy.getDependencies();
    }),
  ).rejects.toThrow(
    "runtime/checkout.ts has no handler or function named missing",
  );
});

it("fails when infra reads a stand-in for a missing export after linking", async () => {
  await collectResourceGraph(() => {
    const standIn = createStandIn("runtime/checkout.ts", "missing");
    const checkout = declare("checkout");
    linkRuntimeModules([
      {
        module: "runtime/checkout.ts",
        standIns: { missing: standIn },
        exports: { run: checkout.api() },
      },
    ]);
    const missing =
      "runtime/checkout.ts has no handler or function named missing";
    expect(() => (standIn as any).arn).toThrow(missing);
    expect(() => (standIn as any).wire).toThrow(missing);
    expect(() => resolveRuntimeTarget(standIn)).toThrow(missing);
    expect(() => resolveDeferred(standIn)).toThrow(missing);
  });
});

it("answers `in` for a stand-in and its function as reads do", async () => {
  await collectResourceGraph(() => {
    const standIn = createStandIn("runtime/checkout.ts", "createOrder");
    const fn = (standIn as any).function;
    expect("wire" in standIn).toBe(true);
    expect("function" in standIn).toBe(true);
    expect("then" in standIn).toBe(false);
    expect("arn" in fn).toBe(true);
    expect("then" in fn).toBe(false);

    const checkout = declare("checkout");
    linkRuntimeModules([
      {
        module: "runtime/checkout.ts",
        standIns: { createOrder: standIn },
        exports: { createOrder: checkout.api() },
      },
    ]);
    expect("wire" in standIn).toBe(true);
    expect("function" in standIn).toBe(true);
    expect("missing" in standIn).toBe(false);
    expect("describe" in fn).toBe(true);
    expect("arn" in fn).toBe(false);
  });
});

it("reads `then` through a linked stand-in, as a linked chain does", async () => {
  await collectResourceGraph(() => {
    const standIn = createStandIn("runtime/checkout.ts", "checkoutFn");
    expect((standIn as any).then).toBeUndefined();
    const checkout = declare("checkout");
    const fn = Object.assign(checkout.fn, { then: "a then field" });
    linkRuntimeModules([
      {
        module: "runtime/checkout.ts",
        standIns: { checkoutFn: standIn },
        exports: { checkoutFn: fn, run: checkout.api() },
      },
    ]);
    expect((standIn as any).then).toBe("a then field");
    expect((standIn as any).function.then).toBe("a then field");
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

it("fails when infra wires a handler before linking, or wires one that isn't exported", async () => {
  await collectResourceGraph(() => {
    const checkout = declare("checkout");
    const early = checkout.api();
    expect(() => early.wire("api", () => {})).toThrow(
      /^The api handler made at .*runtime-link\.test\.ts:\d+ was wired before the runtime modules were linked, so its export isn't known yet\. Import its runtime module with \{ type: "runtime" \}, and pass infra the handler from that import\.$/,
    );
    linkRuntimeModules([
      {
        module: "runtime/checkout.ts",
        standIns: {},
        exports: { createOrder: early },
      },
    ]);
    expect(() => checkout.api().wire("api", () => {})).toThrow(
      /^The api handler made at .*runtime-link\.test\.ts:\d+ isn't exported from a runtime module\./,
    );
  });
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
  declare readonly name: string;
  constructor() {
    Object.defineProperty(this, "name", { value: "orders", enumerable: false });
  }
  get sideEffect(): string {
    throw new Error("a whole read calls no getters");
  }
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

it("delivers the output values and primitives of a whole binding, and not its config", async () => {
  const { delivered, infra } = await collectReads(["infra/orders#orderQueue"]);
  expect(delivered).toEqual({
    "infra/orders#orderQueue": {
      id: "orders",
      name: "orders",
      url: infra.orderQueue.url,
      arn: infra.orderQueue.arn,
    },
  });
});

it("delivers a whole binding that is data as it is", async () => {
  const { delivered } = await collectReads(["infra/orders#settings"]);
  expect(delivered).toEqual({ "infra/orders#settings": { memory: 64 } });
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

it("fails when a function reads through a getter, without calling it", async () => {
  await expect(
    collectReads(["infra/orders#orderQueue.sideEffect.length"]),
  ).rejects.toThrow(
    'The function "checkout" reads infra/orders#orderQueue.sideEffect.length, but infra/orders#orderQueue.sideEffect is a getter.',
  );
});
