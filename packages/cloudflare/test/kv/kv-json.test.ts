import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { NodeDurableRuntime, runDurableWorkflow } from "@notation/core";
import { createPlan, createResourceRegistry } from "@notation/reconciler";
import * as durable from "@notation/reconciler/durable";
import {
  collectResourceGraph,
  ResourceGroup,
  text,
  UNKNOWN_AFTER_APPLY,
  type StandardSchemaV1,
} from "@notation/resource";
import { kvJson, type JsonPartial, type KVJsonGroup } from "src/kv";
import { KVJsonValue } from "src/resources/kv/kv-json-value";
import { KVNamespace } from "src/resources/kv/kv-namespace";
import { calls, fail, mockFetch, ok } from "../mock-api";

const Flags = v.object({
  features: v.record(v.string(), v.boolean()),
  limits: v.optional(v.record(v.string(), v.number())),
});

const scope = { app: "shop", stage: "dev" };
const registry = createResourceRegistry([KVNamespace, KVJsonValue]);

const keyNotFound = () => fail(404, 10009, "get: 'key not found'");

let directory: string;
let runtime: NodeDurableRuntime;
// The stored text of each key in the namespace ns1.
let values: Map<string, string>;

// The KV API of one account with the namespace ns1, once it is created.
function fakeKV() {
  let created = false;
  mockFetch(async (call) => {
    const url = new URL(call.url);
    const route = url.pathname.replace(
      "/client/v4/accounts/acc/storage/kv/namespaces",
      "",
    );
    const namespace = { id: "ns1", title: "config" };
    if (route === "" && call.method === "GET") {
      return ok(created ? [namespace] : []);
    }
    if (route === "" && call.method === "POST") {
      created = true;
      return ok(namespace);
    }
    if (route === "/ns1" && call.method === "GET") return ok(namespace);
    const key = route.match(/^\/ns1\/values\/(.+)$/)?.[1];
    if (key === undefined) return fail(400, 1, `unexpected ${route}`);
    const name = decodeURIComponent(key);
    if (call.method === "PUT") {
      const form = call.body as FormData;
      values.set(name, await (form.get("value") as Blob).text());
      return ok({});
    }
    if (!values.has(name)) return keyNotFound();
    if (call.method === "DELETE") {
      values.delete(name);
      return ok({});
    }
    return new Response(values.get(name)!);
  });
}

type Declare = (namespace: InstanceType<typeof KVNamespace>) => void;

const collect = (declare: Declare) =>
  collectResourceGraph(
    () => {
      const namespace = new KVNamespace("config", {
        config: { Title: "config" },
      });
      declare(namespace);
    },
    { scope },
  );

async function deploy(executionId: string, declare: Declare) {
  const { resources } = await collect(declare);
  await runDurableWorkflow(
    { workflowId: "deploy", runtime, executionId },
    (step, id) =>
      durable.deploy(step, {
        executionId: id,
        resources,
        registry,
        state: runtime.state,
        ...scope,
      }),
  );
}

async function plan(declare: Declare, driftDetection = false) {
  const { resources } = await collect(declare);
  const planned = await createPlan({
    resources,
    state: runtime.state,
    registry,
    driftDetection,
    ...scope,
  });
  return planned.nodes.find((node) => node.id === "kv-json:flags")!;
}

const twoContributions: Declare = (namespace) => {
  const flags = kvJson({
    id: "flags",
    namespace,
    key: "flags",
    schema: Flags,
    value: { features: {} },
  });
  flags.contribute({ features: { invoices: true } });
  flags.contribute({ features: { uploads: true }, limits: { uploadMb: 50 } });
};

beforeEach(async () => {
  calls.length = 0;
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
  directory = await mkdtemp(path.join(tmpdir(), "notation-cf-kv-json-"));
  runtime = new NodeDurableRuntime({
    deployment: scope,
    databasePath: path.join(directory, "workflows.db"),
  });
  values = new Map();
  fakeKV();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runtime.close();
  await rm(directory, { recursive: true, force: true });
});

describe("kvJson()", () => {
  it("writes the value merged with each contribution, with sorted keys", async () => {
    await deploy("first", twoContributions);

    expect(values.get("flags")).toBe(
      '{"features":{"invoices":true,"uploads":true},"limits":{"uploadMb":50}}',
    );
    expect((await runtime.state.get("kv-json:flags"))?.params).toMatchObject({
      Key: "flags",
      Value: {
        features: { invoices: true, uploads: true },
        limits: { uploadMb: 50 },
      },
    });
  });

  it("plans no change on the next deploy, and an update at the key that a contribution changes", async () => {
    await deploy("first", twoContributions);

    expect((await plan(twoContributions, true)).decision).toBe("noop");

    const changed = await plan((namespace) => {
      const flags = kvJson({
        id: "flags",
        namespace,
        key: "flags",
        schema: Flags,
        value: { features: {} },
      });
      flags.contribute({ features: { invoices: false } });
      flags.contribute({
        features: { uploads: true },
        limits: { uploadMb: 50 },
      });
    });
    expect(changed.decision).toBe("update");
    expect(changed.diff?.updated).toEqual({
      Value: { features: { invoices: false } },
    });
  });

  it("removes the keys of a contributor that is removed", async () => {
    await deploy("first", twoContributions);

    await deploy("second", (namespace) => {
      const flags = kvJson({
        id: "flags",
        namespace,
        key: "flags",
        schema: Flags,
        value: { features: {} },
      });
      flags.contribute({ features: { invoices: true } });
    });

    expect(values.get("flags")).toBe('{"features":{"invoices":true}}');
  });

  it("fails plan, before it writes anything, when the merged value fails the schema", async () => {
    const invalid: Declare = (namespace) => {
      const flags = kvJson({
        id: "flags",
        namespace,
        key: "flags",
        schema: Flags,
        value: { features: {} },
      });
      flags.contribute({ features: { invoices: "yes" as any } });
    };

    await expect(plan(invalid)).rejects.toThrow(
      /Invalid Value for kv-json:flags \(cloudflare\/kv\/KVJsonValue\) at plan, declared at \S*test\/kv\/kv-json\.test\.ts:\d+: features\.invoices: Invalid type: Expected boolean but received "yes"/,
    );
    await expect(deploy("first", invalid)).rejects.toThrow(
      "Invalid Value for kv-json:flags",
    );
    expect(values.size).toBe(0);
  });

  it("doesn't check the config at declaration, as a contribution can supply a required field", async () => {
    await expect(
      collect((namespace) => {
        const flags = kvJson({
          id: "flags",
          namespace,
          key: "flags",
          schema: Flags,
          value: { limits: { uploadMb: 50 } },
        });
        flags.contribute({ features: { uploads: true } });
      }),
    ).resolves.toBeDefined();
  });

  it("fails plan when no item supplies a required field", async () => {
    await expect(
      plan((namespace) => {
        kvJson({
          id: "flags",
          namespace,
          key: "flags",
          schema: Flags,
          value: { limits: { uploadMb: 50 } },
        });
      }),
    ).rejects.toThrow(/at plan, declared at .*: features: Invalid key/);
  });

  it("names both call sites in the user's code when two contributions conflict", async () => {
    const error = await plan((namespace) => {
      const flags = kvJson({
        id: "flags",
        namespace,
        key: "flags",
        schema: Flags,
      });
      flags.contribute({ features: { invoices: true } });
      flags.contribute({ features: { invoices: false } });
    }).catch((e) => e);

    expect(error.message).toMatch(
      /^Conflicting contributions to kv-json:flags: \S*test\/kv\/kv-json\.test\.ts:(\d+) and \S*test\/kv\/kv-json\.test\.ts:(\d+) both set Value\.features\.invoices/,
    );
    const [, first, second] = error.message.match(/:(\d+) and .*?:(\d+)/);
    expect(first).not.toBe(second);
  });

  it("names the config when a contribution conflicts with the value option", async () => {
    await expect(
      plan((namespace) => {
        const flags = kvJson({
          id: "flags",
          namespace,
          key: "flags",
          schema: Flags,
          value: { features: { invoices: true } },
        });
        flags.contribute({ features: { invoices: false } });
      }),
    ).rejects.toThrow(
      /the config of kv-json:flags and \S*test\/kv\/kv-json\.test\.ts:\d+ both set Value\.features\.invoices/,
    );
  });

  it("takes a function contribution that reads the outputs of its deps", async () => {
    await deploy("first", (namespace) => {
      const flags = kvJson({
        id: "flags",
        namespace,
        key: "flags",
        schema: v.object({
          features: v.record(v.string(), v.boolean()),
          namespace: v.string(),
        }),
        value: { features: {} },
      });
      flags.contribute(
        ({ deps }) => ({ namespace: deps.namespace.output.NamespaceId }),
        { deps: { namespace } },
      );
    });

    expect(values.get("flags")).toBe('{"features":{},"namespace":"ns1"}');
  });

  it("leaves the other keys known at plan when a contribution maps a ref, and plans its result once the ref is known", async () => {
    let namespace!: InstanceType<typeof KVNamespace>;
    let flags!: KVJsonGroup;
    await collect((ns) => {
      namespace = ns;
      flags = kvJson({
        id: "flags",
        namespace,
        key: "flags",
        schema: v.object({
          features: v.record(v.string(), v.boolean()),
          namespace: v.string(),
        }),
        value: { features: {} },
      });
      flags.contribute({ features: { invoices: true } });
      flags.contribute({
        namespace: namespace.outputRef("NamespaceId").map((id) => `kv:${id}`),
      });
    });

    expect((await flags.value.planParams()).Value).toEqual({
      features: { invoices: true },
      namespace: UNKNOWN_AFTER_APPLY,
    });
    namespace.setOutput({ NamespaceId: "ns1" } as any);
    expect((await flags.value.planParams()).Value).toEqual({
      features: { invoices: true },
      namespace: "kv:ns1",
    });
  });

  it("writes a contribution that maps a ref", async () => {
    await deploy("first", (namespace) => {
      const flags = kvJson({
        id: "flags",
        namespace,
        key: "flags",
        schema: v.object({
          features: v.record(v.string(), v.boolean()),
          namespace: v.string(),
        }),
        value: { features: {} },
      });
      flags.contribute({
        namespace: text`kv:${namespace.outputRef("NamespaceId")}`,
      });
    });

    expect(values.get("flags")).toBe('{"features":{},"namespace":"kv:ns1"}');
  });

  it.each(["not json", "[1e999]"])(
    "plans a drift update, and writes the key again, when the stored text is %j",
    async (stored) => {
      await deploy("first", twoContributions);
      values.set("flags", stored);

      const node = await plan(twoContributions, true);
      expect(node.decision).toBe("drift-update");

      await deploy("second", twoContributions);
      expect(JSON.parse(values.get("flags")!)).toEqual({
        features: { invoices: true, uploads: true },
        limits: { uploadMb: 50 },
      });
    },
  );

  it("takes an id built from its caller's id", async () => {
    const id: string = "router";
    let group!: ReturnType<typeof kvJson>;
    await collect((namespace) => {
      group = kvJson({
        id: `${id}-config`,
        namespace,
        key: "config",
        schema: Flags,
      });
      kvJson({ id, namespace, key: "plain", schema: Flags });
      expect(() =>
        // @ts-expect-error a dot is not name-safe
        kvJson({ id: `${id}.config`, namespace, key: "k", schema: Flags }),
      ).toThrow(`Invalid kvJson() id "router.config"`);
    });
    expect(group.value.id).toBe("kv-json:router-config");
  });

  it("nests in a group that adds it, and records the ancestry in state", async () => {
    class Router extends ResourceGroup {
      platform = "cloudflare";
      readonly routes: KVJsonGroup<typeof Flags>;
      constructor(id: string, namespace: InstanceType<typeof KVNamespace>) {
        super("test/router", id);
        this.routes = this.add(
          kvJson({ id: "routes", namespace, key: "routes", schema: Flags }),
        );
      }
    }
    let router!: Router;
    const declare: Declare = (namespace) => {
      router = new Router("main", namespace);
      router.routes.contribute({ features: { home: true } });
    };

    const graph = await collect(declare);
    expect(router.groups).toEqual([router.routes]);
    expect(router.routes.parent).toEqual({
      type: "test/router",
      id: "main",
      parents: [],
    });
    expect(graph.resourceGroups).toEqual([router, router.routes]);
    const ref = {
      type: "cloudflare/kv/json",
      id: "routes",
      parents: [{ type: "test/router", id: "main" }],
    };
    expect(router.routes.value.group).toEqual(ref);

    await deploy("first", declare);
    expect(values.get("routes")).toBe('{"features":{"home":true}}');
    expect((await runtime.state.get("kv-json:routes"))?.group).toEqual(ref);
  });

  it("keeps the schema on the group", async () => {
    let schema: unknown;
    await collect((namespace) => {
      schema = kvJson({
        id: "flags",
        namespace,
        key: "flags",
        schema: Flags,
      }).schema;
    });
    expect(schema).toBe(Flags);
  });

  it("refuses an id that isn't name-safe, and a missing schema", async () => {
    await expect(
      collect((namespace) => {
        kvJson({
          id: "flags:v2" as any,
          namespace,
          key: "flags",
          schema: Flags,
        });
      }),
    ).rejects.toThrow(`Invalid kvJson() id "flags:v2"`);
    const base: string = "bad id";
    await expect(
      collect((namespace) => {
        kvJson({ id: `${base}-config`, namespace, key: "k", schema: Flags });
      }),
    ).rejects.toThrow(`Invalid kvJson() id "bad id-config"`);
    await expect(
      collect((namespace) => {
        kvJson({
          id: "flags",
          namespace,
          key: "flags",
          schema: undefined as any,
        });
      }),
    ).rejects.toThrow(`kvJson() "flags" requires a schema`);
  });

  it("accepts a schema whose input is an interface, and refuses one whose input isn't JSON", async () => {
    interface Limits {
      uploadMb: number;
      label?: string;
    }
    const limits = {} as StandardSchemaV1<Limits, Limits>;
    const dates = {} as StandardSchemaV1<{ at: Date }, { at: Date }>;
    const declare = (namespace: InstanceType<typeof KVNamespace>) => {
      kvJson({ id: "limits", namespace, key: "limits", schema: limits });
      kvJson({ id: "any", namespace, key: "any", schema: v.unknown() });
      // @ts-expect-error A Date isn't JSON.
      kvJson({ id: "dates", namespace, key: "dates", schema: dates });
    };
    expectTypeOf(declare).toBeFunction();
  });

  it("accepts unknown at any depth of the schema's input, and a recursive JSON schema", async () => {
    type Tree =
      string | number | boolean | null | Tree[] | { [key: string]: Tree };
    const Tree: v.GenericSchema<Tree> = v.lazy(() =>
      v.union([
        v.string(),
        v.number(),
        v.boolean(),
        v.null(),
        v.array(Tree),
        v.record(v.string(), Tree),
      ]),
    );
    const declare = (namespace: InstanceType<typeof KVNamespace>) => {
      kvJson({
        id: "loose",
        namespace,
        key: "loose",
        schema: v.looseObject({ provider: v.string() }),
        value: { provider: "stripe" },
      });
      kvJson({
        id: "rest",
        namespace,
        key: "rest",
        schema: v.objectWithRest({ provider: v.string() }, v.unknown()),
      });
      kvJson({
        id: "nested",
        namespace,
        key: "nested",
        schema: v.object({ settings: v.record(v.string(), v.unknown()) }),
      });
      kvJson({ id: "tree", namespace, key: "tree", schema: Tree });
      kvJson({
        id: "trees",
        namespace,
        key: "trees",
        schema: v.object({ root: Tree, label: v.optional(v.string()) }),
      });
    };
    expectTypeOf(declare).toBeFunction();
  });

  it("refuses a schema with a non-JSON field at any depth, and names the key", async () => {
    const fns = {} as StandardSchemaV1<
      { a: { run: () => void } },
      { a: { run: () => void } }
    >;
    const declare = (namespace: InstanceType<typeof KVNamespace>) => {
      kvJson({
        id: "date",
        namespace,
        key: "date",
        // @ts-expect-error A Date isn't JSON, even next to unknown keys.
        schema: v.looseObject({ meta: v.object({ at: v.date() }) }),
      });
      // @ts-expect-error A function isn't JSON.
      kvJson({ id: "fn", namespace, key: "fn", schema: fns });
    };
    expectTypeOf(declare).toBeFunction();

    type Check<S extends StandardSchemaV1<unknown, unknown>> = Parameters<
      typeof kvJson<S>
    >[0]["schema"];
    expectTypeOf<
      Check<typeof fns>
    >().toEqualTypeOf<"kvJson(): the input type of the schema must be JSON, but the key a.run isn't">();
    const dates = v.looseObject({
      meta: v.object({ at: v.date(), note: v.optional(v.string()) }),
    });
    expectTypeOf<
      Check<typeof dates>
    >().toEqualTypeOf<"kvJson(): the input type of the schema must be JSON, but the key meta.at isn't">();
  });

  it("types each contribution as a partial of the schema's input", () => {
    type Partial = JsonPartial<v.InferInput<typeof Flags>>;
    expectTypeOf<{ features: { uploads: true } }>().toExtend<Partial>();
    expectTypeOf<{ limits: { uploadMb: 50 } }>().toExtend<Partial>();
    expectTypeOf<{ features: { uploads: "yes" } }>().not.toExtend<Partial>();
    expectTypeOf<JsonPartial<{ list: { a: number }[] }>>().toEqualTypeOf<{
      list?: { a: number }[];
    }>();
  });
});
