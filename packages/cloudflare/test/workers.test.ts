import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import type * as cf from "@cloudflare/workers-types";
import { setConfigFile } from "@notation/core";
import {
  collectResourceGraph,
  declaredIn,
  type ResourceGraph,
} from "@notation/resource";
import {
  $durableObject,
  $worker,
  isWorkerGroup,
  type WorkerEnv,
  type WorkerGroup,
} from "src/workers";
import * as runtime from "src/workers/runtime";

const projectDir = "/some/project";

beforeEach(() => setConfigFile(`${projectDir}/notation.config.ts`));
afterEach(() => setConfigFile(undefined));

// Records the module of a declaration, as the infra build does. A Worker's
// record also holds the module's other exports.
const inWorker = <T>(
  declaration: T,
  file: string,
  exports: string[] = [],
  starExports: string[] = [],
): T => declaredIn(declaration, file, "worker", { exports, starExports });

const inModule = <T>(declaration: T, file: string): T =>
  declaredIn(declaration, file, "namespace");

// Stands in for a class that extends DurableObject.
class Counter {
  declare readonly __DURABLE_OBJECT_BRAND: never;
  count(): number {
    return 1;
  }
}
class Room {}

function group(graph: ResourceGraph, id: string): WorkerGroup {
  const found = graph.resourceGroups.find(
    (g) => isWorkerGroup(g) && g.id === id,
  );
  if (!found) throw new Error(`No Worker group ${id} in the graph`);
  return found as WorkerGroup;
}

const collect = (evaluate: () => unknown) =>
  collectResourceGraph(evaluate, { scope: { app: "shop", stage: "dev" } });

describe("$worker", () => {
  it("uploads the runtime bundle of its module, with the default compatibility settings", async () => {
    const graph = await collect(() => {
      inWorker($worker({ id: "api" }), "runtime/api.ts");
    });
    const api = group(graph, "api");

    expect(api.code.config).toEqual({
      filePath: "dist/runtime/api/index.mjs",
    });
    expect(api.script.config).toEqual({
      ScriptName: "shop--dev--api",
      CompatibilityDate: "2026-10-12",
      CompatibilityFlags: ["nodejs_compat"],
      Bindings: [],
      DurableObjectNamespaces: [],
    });
    expect(api.subdomain?.dependencies.script).toBe(api.script);
  });

  it("applies the name, compatibility settings and url options", async () => {
    const graph = await collect(() => {
      inWorker(
        $worker({
          id: "api",
          name: "public-api",
          compatibilityDate: "2026-01-01",
          compatibilityFlags: [],
          url: false,
        }),
        "runtime/api.ts",
      );
    });
    const api = group(graph, "api");

    expect(api.script.config).toMatchObject({
      ScriptName: "shop--dev--public-api",
      CompatibilityDate: "2026-01-01",
      CompatibilityFlags: [],
    });
    expect(api.subdomain).toBeUndefined();
  });

  it("binds strings as plain text and other Workers as services", async () => {
    const graph = await collect(() => {
      const auth = inWorker($worker({ id: "auth" }), "runtime/auth.ts");
      inWorker(
        $worker({
          id: "api",
          bindings: () => ({ GREETING: "hello", AUTH: auth }),
        }),
        "runtime/api.ts",
      );
    });
    const api = group(graph, "api");

    expect(api.script.config.Bindings).toEqual([
      { type: "plain_text", name: "GREETING", text: "hello" },
      { type: "service", name: "AUTH", service: "shop--dev--auth" },
    ]);
    expect(api.script.getDependencies()).toContain(group(graph, "auth").script);
  });

  it("hosts a namespace whose class its module exports", async () => {
    const graph = await collect(() => {
      const counters = inModule(
        $durableObject({ id: "counters", class: Counter }),
        "runtime/counter.ts",
      );
      inWorker(
        $worker({ id: "api", bindings: () => ({ COUNTERS: counters }) }),
        "runtime/api.ts",
        ["Counter"],
      );
    });
    const api = group(graph, "api");

    expect(api.script.config.Bindings).toEqual([
      {
        type: "durable_object_namespace",
        name: "COUNTERS",
        class_name: "Counter",
      },
    ]);
    expect(api.script.config.DurableObjectNamespaces).toEqual([
      { id: "counters", className: "Counter" },
    ]);
  });

  it("binds a namespace that another Worker hosts on that Worker, and uploads after it", async () => {
    const graph = await collect(() => {
      const counters = inModule(
        $durableObject({ id: "counters", class: Counter }),
        "runtime/counter.ts",
      );
      inWorker(
        $worker({ id: "reports", bindings: () => ({ COUNTERS: counters }) }),
        "runtime/reports.ts",
      );
      inWorker(
        $worker({ id: "api", bindings: () => ({ COUNTERS: counters }) }),
        "runtime/api.ts",
        ["Counter"],
      );
    });
    const reports = group(graph, "reports");

    expect(reports.script.config.Bindings).toEqual([
      {
        type: "durable_object_namespace",
        name: "COUNTERS",
        class_name: "Counter",
        script_name: "shop--dev--api",
      },
    ]);
    expect(reports.script.config.DurableObjectNamespaces).toEqual([]);
    expect(reports.script.getDependencies()).toContain(
      group(graph, "api").script,
    );
  });

  it("fails for a namespace that no Worker that binds it exports the class of", async () => {
    await expect(
      collect(() => {
        const counters = inModule(
          $durableObject({ id: "counters", class: Counter }),
          "runtime/counter.ts",
        );
        inWorker(
          $worker({ id: "api", bindings: () => ({ COUNTERS: counters }) }),
          "runtime/api.ts",
          [],
          ["./counter"],
        );
      }),
    ).rejects.toThrow(
      `runtime/api.ts doesn't export Counter, the class of $durableObject({ id: "counters" }) in runtime/counter.ts, which the Worker "api" binds as COUNTERS. Export the class from the Worker's module under that name, as Cloudflare finds the class by its export name, or from the module of another Worker that binds the namespace. The bundle doesn't re-export the names of export * from "./counter", so export Counter by name.`,
    );
  });

  it("fails when two Workers would host the same namespace", async () => {
    await expect(
      collect(() => {
        const counters = inModule(
          $durableObject({ id: "counters", class: Counter }),
          "runtime/counter.ts",
        );
        for (const id of ["api", "reports"]) {
          inWorker(
            $worker({ id, bindings: () => ({ COUNTERS: counters }) }),
            `runtime/${id}.ts`,
            ["Counter"],
          );
        }
      }),
    ).rejects.toThrow(
      `The Workers "api" and "reports" each export Counter and bind $durableObject({ id: "counters" }) in runtime/counter.ts, so each would host the namespace.`,
    );
  });

  it("fails for two namespaces with the same class in one Worker", async () => {
    await expect(
      collect(() => {
        const a = $durableObject({ id: "a", class: Counter });
        const b = $durableObject({ id: "b", class: Counter });
        inWorker(
          $worker({ id: "api", bindings: () => ({ A: a, B: b }) }),
          "runtime/api.ts",
          ["Counter"],
        );
      }),
    ).rejects.toThrow(
      `hosts the namespaces "a" and "b", which both have the class Counter`,
    );
  });

  it("fails for two Workers that bind each other", async () => {
    await expect(
      collect(() => {
        const api: unknown = inWorker(
          $worker({ id: "api", bindings: () => ({ REPORTS: reports }) }),
          "runtime/api.ts",
        );
        const reports = inWorker(
          $worker({ id: "reports", bindings: () => ({ API: api as any }) }),
          "runtime/reports.ts",
        );
      }),
    ).rejects.toThrow(
      `The Workers "api" → "reports" → "api" bind each other in a cycle.`,
    );
  });

  it("fails when the host of a namespace binds a Worker that binds the namespace on it", async () => {
    await expect(
      collect(() => {
        const counters = inModule(
          $durableObject({ id: "counters", class: Counter }),
          "runtime/counter.ts",
        );
        const api: unknown = inWorker(
          $worker({
            id: "api",
            bindings: () => ({ COUNTERS: counters, REPORTS: reports }),
          }),
          "runtime/api.ts",
          ["Counter"],
        );
        const reports = inWorker(
          $worker({
            id: "reports",
            bindings: () => ({ COUNTERS: counters, API: api as any }),
          }),
          "runtime/reports.ts",
        );
      }),
    ).rejects.toThrow(
      `The Workers "api" → "reports" → "api" bind each other in a cycle.`,
    );
  });

  it("builds a Worker that binds itself", async () => {
    const graph = await collect(() => {
      const api: unknown = inWorker(
        $worker({ id: "api", bindings: () => ({ SELF: api as any }) }),
        "runtime/api.ts",
      );
    });
    expect(group(graph, "api").script.config.Bindings).toEqual([
      { type: "service", name: "SELF", service: "shop--dev--api" },
    ]);
  });

  it("fails for a binding that a Worker can't bind", async () => {
    await expect(
      collect(() => {
        inWorker(
          $worker({ id: "api", bindings: () => ({ PORT: 8080 as any }) }),
          "runtime/api.ts",
        );
      }),
    ).rejects.toThrow(
      `$worker({ id: "api" }) in runtime/api.ts binds PORT to a value that a Worker can't bind.`,
    );
  });

  it("fails for a Worker that the infra build didn't record", async () => {
    await expect(
      collect(() => {
        $worker({ id: "api" });
      }),
    ).rejects.toThrow(`The Worker "api" has no module.`);
  });

  it("fails for an id that is not a valid Worker name", async () => {
    await expect(
      collect(() => {
        $worker({ id: "Orders_API" });
      }),
    ).rejects.toThrow(`Invalid $worker id "Orders_API"`);
  });

  it("fails when two Workers get the same name", async () => {
    await expect(
      collect(() => {
        inWorker($worker({ id: "api" }), "runtime/api.ts");
        inWorker($worker({ id: "other", name: "api" }), "runtime/other.ts");
      }),
    ).rejects.toThrow(`give two Workers the same name, "shop--dev--api"`);
  });
});

describe("$durableObject", () => {
  it("fails for a class that isn't a name, which the infra build gives no name", () => {
    const unnamed = (() => () => {})();
    expect(() =>
      $durableObject({ id: "counters", class: unnamed as any }),
    ).toThrow(
      `$durableObject({ id: "counters" }) expects class to name a class that its module declares or imports`,
    );
  });

  it("fails for two namespaces with the same id", async () => {
    await expect(
      collect(() => {
        $durableObject({ id: "rooms", class: Room });
        $durableObject({ id: "rooms", class: Counter });
      }),
    ).rejects.toThrow(`Duplicate $durableObject id "rooms"`);
  });
});

describe("runtime", () => {
  it("keeps only the ids of the declarations", () => {
    const counters = runtime.$durableObject({ id: "counters", class: Counter });
    expect(counters).toEqual({ id: "counters" });
    expect(
      runtime.$worker({ id: "api", bindings: () => ({ COUNTERS: counters }) }),
    ).toEqual({ id: "api" });
  });

  it("has the same exports as the infra entry", async () => {
    const infra = await import("src/workers");
    expect(Object.keys(runtime).sort()).toEqual(Object.keys(infra).sort());
  });
});

describe("WorkerEnv", () => {
  it("types each binding from its value", () => {
    const counters = runtime.$durableObject({ id: "counters", class: Counter });
    const auth = runtime.$worker({ id: "auth" });
    const worker = runtime.$worker({
      id: "api",
      bindings: () => ({ COUNTERS: counters, AUTH: auth, GREETING: "hi" }),
    });
    type Env = WorkerEnv<typeof worker>;

    expectTypeOf<Env["COUNTERS"]>().toEqualTypeOf<
      cf.DurableObjectNamespace<Counter>
    >();
    expectTypeOf<Env["AUTH"]>().toEqualTypeOf<cf.Fetcher>();
    expectTypeOf<Env["GREETING"]>().toEqualTypeOf<string>();
    // @ts-expect-error a name that the declaration doesn't bind
    type _ = Env["MISSING"];
  });
});
