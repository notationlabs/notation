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
  type StandardSchemaV1,
} from "@notation/resource";
import { kvJson, type JsonPartial } from "src/kv";
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
      // @ts-expect-error A Date isn't JSON.
      kvJson({ id: "dates", namespace, key: "dates", schema: dates });
    };
    expectTypeOf(declare).toBeFunction();
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
