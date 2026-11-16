import * as v from "valibot";
import { resource, type BaseResource } from "@notation/resource";
import { isCreatingRecord } from "@notation/state";
import { clearSecretValues } from "@notation/utils";
import { beforeEach, describe, expect, it } from "vitest";
import { clearHeldCredentials } from "../src/credentials";
import { createPlan } from "../src/planner";
import { instanceHash } from "../src/overrides";
import {
  UnobtainableCredentialError,
  credentialVariable,
} from "../src/unobtainable-credential";
import { createRuntime } from "./credentials-runtime";

type Runtime = ReturnType<typeof createRuntime>;

type TokenSchema = {
  Key: { id: string };
  CreateParams: { scope: string };
  UpdateParams: {};
  ReadResult: {};
};

type SecretSchema = {
  Key: { name: string };
  CreateParams: { name: string; Value: string; label?: string };
  UpdateParams: { Value: string; label?: string };
  ReadResult: {};
};

/** What the fake provider holds, across deploys. */
type Provider = {
  tokens: Map<string, string>;
  secrets: Map<string, string>;
  calls: string[];
  /** The state that the last rotate received. */
  rotateState?: unknown;
  /** The state that the last update of a secret received. */
  updateState?: unknown;
  failSecret?: string;
};

function createProvider(): Provider {
  return { tokens: new Map(), secrets: new Map(), calls: [] };
}

function defineResources(
  provider: Provider,
  { rotate, rotateManually }: { rotate: boolean; rotateManually?: string },
) {
  let issued = 0;
  const issue = (id: string) => {
    issued += 1;
    const value = `token-value-${issued}`;
    provider.tokens.set(id, value);
    return value;
  };

  const Token = resource<TokenSchema>({
    type: rotate ? "test/credentials/RotatableToken" : "test/credentials/Token",
    provider: "test",
  })
    .defineSchema({
      scope: {
        propertyType: "param",
        presence: "required",
        immutable: true,
        value: v.string(),
      },
      id: {
        propertyType: "computed",
        presence: "required",
        primaryKey: true,
        value: v.string(),
      },
      Value: { propertyType: "credential", value: v.string() },
    } as const)
    .defineOperations({
      create: async () => {
        const id = `token-${provider.tokens.size + provider.calls.length}`;
        provider.calls.push(`create ${id}`);
        return { id, Value: issue(id) };
      },
      ...(rotate
        ? {
            rotate: {
              Value: async (key, state) => {
                provider.rotateState = state;
                provider.calls.push(`rotate ${key.id}`);
                return issue(key.id);
              },
            },
          }
        : {}),
      ...(rotateManually ? { rotateManually: { Value: rotateManually } } : {}),
      delete: async (key) => {
        provider.calls.push(`delete ${key.id}`);
        provider.tokens.delete(key.id);
      },
    });

  const Secret = resource<SecretSchema>({
    type: "test/credentials/Secret",
    provider: "test",
  })
    .defineSchema({
      name: {
        propertyType: "param",
        presence: "required",
        immutable: true,
        primaryKey: true,
        value: v.string(),
      },
      Value: {
        propertyType: "param",
        presence: "required",
        sensitive: true,
        value: v.string(),
      },
      label: { propertyType: "param", presence: "optional", value: v.string() },
    } as const)
    .defineOperations({
      create: async (params) => {
        provider.calls.push(`create ${params.name}`);
        if (provider.failSecret === params.name) {
          throw new Error(`The store refused ${params.Value}`);
        }
        provider.secrets.set(params.name, params.Value);
      },
      update: async (key, patch, _params, state) => {
        provider.updateState = state;
        provider.calls.push(`update ${key.name}`);
        if (provider.failSecret === key.name) {
          throw new Error(`The store refused ${patch.Value}`);
        }
        if (patch.Value !== undefined) {
          provider.secrets.set(key.name, patch.Value);
        }
      },
      delete: async (key) => {
        provider.calls.push(`delete ${key.name}`);
        provider.secrets.delete(key.name);
      },
    });

  return { Token, Secret };
}

type Declared = {
  scope?: string;
  secrets: (string | { name: string; label: string })[];
};

/**
 * Declares one token, and a secret for each name that takes the token's
 * credential. Each deploy declares its resources again, as a new process
 * does.
 */
function declare(
  types: ReturnType<typeof defineResources>,
  { scope = "read", secrets }: Declared,
): BaseResource[] {
  const token = new types.Token("token", { config: { scope } });
  return [
    token,
    ...secrets.map((secret) => {
      const config = typeof secret === "string" ? { name: secret } : secret;
      return new types.Secret(`secret:${config.name}`, {
        config: { ...config, Value: token.credentials.Value },
      });
    }),
  ];
}

beforeEach(() => {
  clearHeldCredentials();
  clearSecretValues();
});

describe("a credential", () => {
  it("is passed to the resource that takes it, and is not written to state or the journal", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime();

    await runtime.deploy("first", declare(types, { secrets: ["a"] }));

    expect(provider.secrets.get("a")).toBe("token-value-1");
    const token = await runtime.state.get("token");
    const version = (token!.output.Value as any).$credential.version;
    expect(version).toEqual(expect.any(String));
    expect(token!.output.Value).toEqual({
      $credential: { resource: "token", name: "Value", version },
    });
    expect((await runtime.state.get("secret:a"))!.params.Value).toEqual(
      token!.output.Value,
    );
    // The dump holds the journal and state: it has the marker.
    expect(runtime.dump()).toContain("$credential");
    expect(runtime.dump()).not.toContain("token-value-1");
    runtime.close();
  });

  it("is left alone by a deploy that changes nothing", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    provider.calls.length = 0;

    await runtime.nextProcess("second", declare(types, { secrets: ["a"] }));

    expect(provider.calls).toEqual([]);
    runtime.close();
  });

  it("updates the resources that take it when its resource is replaced", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a", "b"] }));

    await runtime.nextProcess(
      "second",
      declare(types, { scope: "write", secrets: ["a", "b"] }),
    );

    expect(provider.secrets.get("a")).toBe("token-value-2");
    expect(provider.secrets.get("b")).toBe("token-value-2");
    expect(runtime.dump()).not.toContain("token-value");
    runtime.close();
  });

  it("is removed from the error of the resource that takes it", async () => {
    const provider = createProvider();
    provider.failSecret = "a";
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime();

    await expect(
      runtime.deploy("first", declare(types, { secrets: ["a"] })),
    ).rejects.toThrow("The store refused <hidden>");
    expect(runtime.dump()).not.toContain("token-value-1");
    runtime.close();
  });
});

describe("a resource that takes a credential in a later deploy", () => {
  it("gets a rotated value, and so does every resource that already takes it", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    provider.calls.length = 0;

    await runtime.nextProcess(
      "second",
      declare(types, { secrets: ["a", "b"] }),
    );

    expect(provider.calls).toEqual(["rotate token-0", "update a", "create b"]);
    expect(provider.rotateState).toEqual({ id: "token-0", scope: "read" });
    expect(provider.secrets.get("a")).toBe("token-value-2");
    expect(provider.secrets.get("b")).toBe("token-value-2");
    expect(provider.tokens.get("token-0")).toBe("token-value-2");
    expect(runtime.dump()).not.toContain("token-value");
    runtime.close();
  });

  it("fails without rotate, and names the flags that can give a value", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    provider.calls.length = 0;

    const error = await runtime
      .nextProcess("second", declare(types, { secrets: ["a", "b"] }))
      .catch((e: Error) => e);

    const record = await runtime.state.get("token");
    const hash = instanceHash(
      "credentials",
      declare(types, { secrets: [] })[0]!,
      record!,
    );
    expect((error as Error).message).toBe(
      [
        "`secret:b` is new, and takes `token.Value`. Notation does not store the value, and `test/credentials/Token` has no operation that issues another.",
        "",
        "  Issue a new value of `Value` at the provider of `test/credentials/Token`. Then set the environment variable `TOKEN_VALUE` to the value, and pass it:",
        `    notation deploy --credential token.Value@${hash}=TOKEN_VALUE`,
        "",
        "  Or replace `token`. Deploy deletes `token` and creates it again with a new value, so whatever exists only in the old `token` is lost:",
        `    notation deploy --replace token@${hash}`,
      ].join("\n"),
    );
    expect(provider.calls).toEqual([]);
    runtime.close();
  });

  it("prints the class's rotateManually sentence above the --credential command", async () => {
    const types = defineResources(createProvider(), {
      rotate: false,
      rotateManually: "Generate a new value in the token's settings.",
    });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));

    const error = await runtime
      .nextProcess("second", declare(types, { secrets: ["a", "b"] }))
      .catch((e: Error) => e);

    expect((error as Error).message).toMatch(
      /\n  Generate a new value in the token's settings\. Then set the environment variable `TOKEN_VALUE` to the value, and pass it:\n    notation deploy --credential token\.Value@/,
    );
    runtime.close();
  });

  it("is planned as deploy does it", async () => {
    const provider = createProvider();
    const rotatable = defineResources(provider, { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(rotatable, { secrets: ["a"] }));

    const plan = await createPlan({
      app: "app",
      stage: "test",
      resources: declare(rotatable, { secrets: ["a", "b"] }),
      state: runtime.state,
    });

    const [token, a, b] = plan.nodes;
    expect(token).toMatchObject({ decision: "noop", rotates: ["Value"] });
    expect(a).toMatchObject({ decision: "update" });
    expect(b).toMatchObject({ decision: "create" });
    runtime.close();
  });

  it("fails the plan without rotate", async () => {
    const types = defineResources(createProvider(), { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));

    await expect(
      createPlan({
        app: "app",
        stage: "test",
        resources: declare(types, { secrets: ["a", "b"] }),
        state: runtime.state,
        deploymentId: "credentials",
      }),
    ).rejects.toThrow(
      /`secret:b` is new, and takes `token\.Value`\.[\s\S]*--credential token\.Value@[0-9a-f]{8}=TOKEN_VALUE[\s\S]*--replace token@[0-9a-f]{8}/,
    );
    runtime.close();
  });

  describe("when deploy cannot get several", () => {
    // Two tokens, each with a secret that takes its credential, and with
    // `added` secrets that take it as well.
    const declareTwo = (
      types: ReturnType<typeof defineResources>,
      added: string[],
    ): BaseResource[] =>
      ["token", "key"].flatMap((id) => {
        const token = new types.Token(id, { config: { scope: "read" } });
        return [
          token,
          ...[id, ...added].map(
            (name) =>
              new types.Secret(`secret:${id}:${name}`, {
                config: {
                  name: `${id}:${name}`,
                  Value: token.credentials.Value,
                },
              }),
          ),
        ];
      });

    it("fails the plan with each of them once", async () => {
      const types = defineResources(createProvider(), { rotate: false });
      const runtime = createRuntime();
      await runtime.deploy("first", declareTwo(types, []));

      const error = await createPlan({
        app: "app",
        stage: "test",
        resources: declareTwo(types, ["b", "c"]),
        state: runtime.state,
        deploymentId: "credentials",
      }).catch((e: Error) => e);

      expect(UnobtainableCredentialError.is(error)).toBe(true);
      expect(
        (error as UnobtainableCredentialError).credentials.map(
          ({ consumer, producer }) => `${consumer} ${producer}`,
        ),
      ).toEqual(["secret:token:b token", "secret:key:b key"]);
      const message = (error as Error).message;
      expect(message).toMatch(
        /^2 credentials need a new value before deploy can run\. Each is listed below with two flags\. Choose one flag for each\.\n\n`secret:token:b` is new/,
      );
      expect(message).toMatch(
        /\n    --credential token\.Value@[0-9a-f]{8}=TOKEN_VALUE\n/,
      );
      expect(message).toMatch(
        /\n    --replace key@[0-9a-f]{8}\n\nThen run deploy with the flags that you chose:\n  notation deploy <flags>$/,
      );
      runtime.close();
    });

    it("fails the deploy with each of them before it changes anything", async () => {
      const provider = createProvider();
      const types = defineResources(provider, { rotate: false });
      const runtime = createRuntime();
      await runtime.deploy("first", declareTwo(types, []));
      provider.calls.length = 0;

      const error = await runtime
        .nextProcess("second", declareTwo(types, ["b"]))
        .catch((e: Error) => e);

      expect(
        (error as UnobtainableCredentialError).credentials.map(
          ({ producer }) => producer,
        ),
      ).toEqual(["token", "key"]);
      expect(provider.calls).toEqual([]);
      runtime.close();
    });
  });

  it("fails the plan with the request's hashes in the deploy commands", async () => {
    const types = defineResources(createProvider(), { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    const resources = declare(types, { secrets: ["a", "b"] });
    const hash = instanceHash(
      "credentials",
      resources[1]!,
      (await runtime.state.get("secret:a"))!,
    );

    const error = await createPlan({
      app: "app",
      stage: "test",
      resources,
      state: runtime.state,
      deploymentId: "credentials",
      overrides: { replace: [{ id: "secret:a" }] },
    }).catch((e: Error) => e);

    expect(UnobtainableCredentialError.is(error)).toBe(true);
    expect((error as UnobtainableCredentialError).overrides).toEqual({
      replace: [{ id: "secret:a", instanceHash: hash }],
    });
    expect((error as Error).message).toContain(
      `notation deploy --replace secret:a@${hash} --credential token.Value@`,
    );
    runtime.close();
  });
});

describe("a deploy that fails before a resource took the new value", () => {
  it("rotates again in the next deploy, and updates every resource", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    provider.failSecret = "b";
    await expect(
      runtime.nextProcess("second", declare(types, { secrets: ["a", "b"] })),
    ).rejects.toThrow("The store refused");
    provider.failSecret = undefined;
    provider.calls.length = 0;

    await runtime.nextProcess("third", declare(types, { secrets: ["a", "b"] }));

    expect(provider.calls).toEqual(["rotate token-0", "update a", "create b"]);
    expect(provider.secrets.get("a")).toBe("token-value-3");
    expect(provider.secrets.get("b")).toBe("token-value-3");
    runtime.close();
  });
});

describe("a resource that is replaced and takes a credential", () => {
  it("rotates the credential when it is reached, and updates the resources before it", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a", "b"] }));
    provider.calls.length = 0;

    // The id is the same, so the token cannot tell that "b" needs a value.
    const [token, a] = declare(types, { secrets: ["a"] });
    const b = new types.Secret("secret:b", {
      config: { name: "b2", Value: (token as any).credentials.Value },
    });
    await runtime.nextProcess("second", [token!, a!, b]);

    expect(provider.calls).toEqual([
      "rotate token-0",
      "update a",
      "delete b",
      "create b2",
    ]);
    expect(provider.secrets.get("a")).toBe("token-value-2");
    expect(provider.secrets.get("b2")).toBe("token-value-2");

    provider.calls.length = 0;
    await runtime.nextProcess("third", [
      ...declare(types, { secrets: ["a"] }).slice(0, 2),
      b,
    ]);
    expect(provider.calls).toEqual([]);
    runtime.close();
  });

  it("fails without rotate, and takes a value that --credential passes", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a", "b"] }));
    const renamed = () => {
      const [token, a] = declare(types, { secrets: ["a"] });
      return [
        token!,
        a!,
        new types.Secret("secret:b", {
          config: { name: "b2", Value: (token as any).credentials.Value },
        }),
      ];
    };

    await expect(runtime.nextProcess("second", renamed())).rejects.toThrow(
      "Deploy replaces `secret:b`, which takes `token.Value`.",
    );
    expect(provider.secrets.get("b")).toBe("token-value-1");

    const record = await runtime.state.get("token");
    const version = (record!.output.Value as any).$credential.version;
    const hash = instanceHash("credentials", renamed()[0]!, record!);
    process.env.TEST_TOKEN_VALUE = "passed-value";
    try {
      provider.calls.length = 0;
      await runtime.nextProcess("third", renamed(), {
        replace: [],
        credential: [
          {
            id: "token",
            name: "Value",
            instanceHash: hash,
            variable: "TEST_TOKEN_VALUE",
          },
        ],
      });
    } finally {
      delete process.env.TEST_TOKEN_VALUE;
    }
    expect(provider.calls).toEqual(["update a", "delete b", "create b2"]);
    expect(provider.secrets.get("a")).toBe("passed-value");
    expect(provider.secrets.get("b2")).toBe("passed-value");
    const after = await runtime.state.get("token");
    expect((after!.output.Value as any).$credential.version).not.toBe(version);
    expect(runtime.dump()).not.toContain("passed-value");
    runtime.close();
  });
});

describe("a deploy that cannot get a credential for a resource that it replaces", () => {
  it("fails before it changes a resource that comes first", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a", "b"] }));
    provider.calls.length = 0;
    const [token, a] = declare(types, {
      secrets: [{ name: "a", label: "changed" }],
    });
    const b = new types.Secret("secret:b", {
      config: { name: "b2", Value: (token as any).credentials.Value },
    });

    await expect(
      runtime.nextProcess("second", [token!, a!, b]),
    ).rejects.toThrow("Deploy replaces `secret:b`, which takes `token.Value`.");
    expect(provider.calls).toEqual([]);
    runtime.close();
  });
});

describe("a plan with a resource that is replaced and takes a credential", () => {
  const renamed = (types: ReturnType<typeof defineResources>) => {
    const [token, a] = declare(types, { secrets: ["a"] });
    return [
      token!,
      a!,
      new types.Secret("secret:b", {
        config: { name: "b2", Value: (token as any).credentials.Value },
      }),
    ];
  };

  it("shows the rotation, and the update of the resources before it", async () => {
    const types = defineResources(createProvider(), { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a", "b"] }));

    const plan = await createPlan({
      app: "app",
      stage: "test",
      resources: renamed(types),
      state: runtime.state,
    });

    const [token, a, b] = plan.nodes;
    expect(token).toMatchObject({ decision: "noop", rotates: ["Value"] });
    expect(a).toMatchObject({ decision: "update" });
    expect(b).toMatchObject({ decision: "replace" });
    runtime.close();
  });

  it("fails at the resource without rotate", async () => {
    const types = defineResources(createProvider(), { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a", "b"] }));

    await expect(
      createPlan({
        app: "app",
        stage: "test",
        resources: renamed(types),
        state: runtime.state,
      }),
    ).rejects.toThrow("Deploy replaces `secret:b`, which takes `token.Value`.");
    runtime.close();
  });

  it("shows a value that --credential passes as a new value", async () => {
    const types = defineResources(createProvider(), { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a", "b"] }));

    const plan = await createPlan({
      app: "app",
      stage: "test",
      resources: renamed(types),
      state: runtime.state,
      deploymentId: "credentials",
      overrides: {
        replace: [],
        credential: [{ id: "token", name: "Value", variable: "VALUE" }],
      },
    });

    const [token, a, b] = plan.nodes;
    expect(token).toMatchObject({ decision: "noop", rotates: ["Value"] });
    expect(a).toMatchObject({ decision: "update" });
    expect(b).toMatchObject({ decision: "replace" });
    runtime.close();
  });

  it("passes with --replace of the credential's resource", async () => {
    const types = defineResources(createProvider(), { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a", "b"] }));

    const plan = await createPlan({
      app: "app",
      stage: "test",
      resources: renamed(types),
      state: runtime.state,
      deploymentId: "credentials",
      overrides: { replace: [{ id: "token" }] },
    });

    const [token, a, b] = plan.nodes;
    expect(token).toMatchObject({ decision: "replace" });
    expect(a).toMatchObject({ decision: "update" });
    expect(b).toMatchObject({ decision: "replace" });
    runtime.close();
  });
});

describe("a create that returns a credential its validator rejects", () => {
  it("fails with the credential's name, records the resource, and refuses --credential for it", async () => {
    const Token = resource<{
      Key: { id: string };
      CreateParams: {};
      UpdateParams: {};
      ReadResult: {};
    }>({ type: "test/credentials/InvalidToken", provider: "test" })
      .defineSchema({
        id: {
          propertyType: "computed",
          presence: "required",
          primaryKey: true,
          value: v.string(),
        },
        Value: {
          propertyType: "credential",
          value: v.pipe(v.string(), v.minLength(20)),
        },
      } as const)
      .defineOperations({
        create: async () => ({ id: "token-0", Value: "short-value" }),
        delete: async () => {},
      });
    const runtime = createRuntime();

    const error = await runtime
      .deploy("first", [new Token("token", { config: {} })])
      .catch((e: Error) => e);

    expect((error as Error).message).toContain(
      "create returned a value that its validator rejects for these credentials: Value",
    );
    expect((error as Error).message).not.toContain("short-value");
    expect((await runtime.state.get("token"))?.output.id).toBe("token-0");

    await expect(
      createPlan({
        app: "app",
        stage: "test",
        resources: [new Token("token", { config: {} })],
        state: runtime.state,
        deploymentId: "credentials",
        overrides: {
          replace: [],
          credential: [{ id: "token", name: "Value", variable: "VALUE" }],
        },
      }),
    ).resolves.toMatchObject({
      nodes: [{ id: "token", decision: "noop", rotates: ["Value"] }],
    });
    runtime.close();
  });
});

describe("a deploy that is resumed after it created a credential", () => {
  const crashAfterStep = "notation:deploy:token:create:remote:effect:0";

  it("rotates the credential for the resource that takes it", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const runtime = createRuntime({ crashAfterStep });
    const resources = declare(types, { secrets: ["a"] });
    await expect(runtime.deploy("first", resources)).rejects.toThrow(
      "simulated process crash",
    );

    await runtime.nextProcess("first", declare(types, { secrets: ["a"] }));

    expect(provider.calls).toEqual([
      "create token-0",
      "rotate token-0",
      "create a",
    ]);
    expect(provider.secrets.get("a")).toBe("token-value-2");
    expect(runtime.dump()).not.toContain("token-value");

    provider.calls.length = 0;
    await runtime.nextProcess("second", declare(types, { secrets: ["a"] }));
    expect(provider.calls).toEqual([]);
    runtime.close();
  });

  it("fails without rotate, and the next deploy can replace the credential's resource", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime({ crashAfterStep });
    await expect(
      runtime.deploy("first", declare(types, { secrets: ["a"] })),
    ).rejects.toThrow("simulated process crash");

    await expect(
      runtime.nextProcess("first", declare(types, { secrets: ["a"] })),
    ).rejects.toThrow(
      "`secret:a` takes `token.Value`, and the deploy run that received its value has ended.",
    );

    const resources = declare(types, { secrets: ["a"] });
    const hash = instanceHash(
      "credentials",
      resources[0]!,
      (await runtime.state.get("token"))!,
    );
    await runtime.nextProcess("second", resources, {
      replace: [{ id: "token", instanceHash: hash }],
    });
    expect(provider.secrets.get("a")).toBe("token-value-2");
    runtime.close();
  });
});

describe("a deploy that is resumed after a resource took a credential", () => {
  it("updates that resource when it rotates the credential for the next one", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const runtime = createRuntime({
      crashAfterStep: "notation:deploy:secret%3Aa:create:remote:effect:0",
    });
    await expect(
      runtime.deploy("first", declare(types, { secrets: ["a", "b"] })),
    ).rejects.toThrow("simulated process crash");
    expect(provider.calls).toEqual(["create token-0", "create a"]);

    await runtime.nextProcess("first", declare(types, { secrets: ["a", "b"] }));

    expect(provider.calls).toEqual([
      "create token-0",
      "create a",
      "rotate token-0",
      "update a",
      "create b",
    ]);
    expect(provider.secrets.get("a")).toBe("token-value-2");
    expect(provider.secrets.get("b")).toBe("token-value-2");
    expect(provider.tokens.get("token-0")).toBe("token-value-2");

    provider.calls.length = 0;
    await runtime.nextProcess(
      "second",
      declare(types, { secrets: ["a", "b"] }),
    );
    expect(provider.calls).toEqual([]);
    runtime.close();
  });
});

describe("a deploy that is resumed after a resource took a credential without rotate", () => {
  it("completes, as the replayed create does not need the value", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime({
      crashAfterStep: "notation:deploy:secret%3Aa:create:remote:effect:0",
    });
    await expect(
      runtime.deploy("first", declare(types, { secrets: ["a"] })),
    ).rejects.toThrow("simulated process crash");

    await runtime.nextProcess("first", declare(types, { secrets: ["a"] }));

    expect(provider.calls).toEqual(["create token-0", "create a"]);
    expect(provider.secrets.get("a")).toBe("token-value-1");
    const record = await runtime.state.get("secret:a");
    expect(record).toBeDefined();
    expect(isCreatingRecord(record!)).toBe(false);
    runtime.close();
  });
});

describe("a deploy that is resumed after an update of a resource that takes two credentials", () => {
  it("gives the resource again only the credential that it did not receive", async () => {
    const provider = createProvider();
    const rotatable = defineResources(provider, { rotate: true });
    const fixed = defineResources(provider, { rotate: false });
    const declareBoth = (secrets: string[]) => {
      const rotating = new rotatable.Token("rotating", {
        config: { scope: "read" },
      });
      const unrotatable = new fixed.Token("fixed", {
        config: { scope: "read" },
      });
      return [
        rotating,
        unrotatable,
        ...secrets.map(
          (name) =>
            new rotatable.Secret(`secret:${name}`, {
              config: {
                name,
                Value: rotating.credentials.Value,
                ...(name === "a"
                  ? { label: unrotatable.credentials.Value }
                  : {}),
              },
            }),
        ),
      ];
    };
    const runtime = createRuntime({
      crashAfterStep: "notation:deploy:secret%3Aa:update:remote:attempt:0",
    });
    await runtime.deploy("first", declareBoth(["a"]));

    await expect(
      runtime.nextProcess("second", declareBoth(["a", "b"])),
    ).rejects.toThrow("simulated process crash");
    await runtime.nextProcess("second", declareBoth(["a", "b"]));

    const rotated = provider.tokens.get("token-0");
    expect(provider.secrets.get("a")).toBe(rotated);
    expect(provider.secrets.get("b")).toBe(rotated);
    runtime.close();
  });
});

describe("the state that an operation receives", () => {
  it("has no marker for a credential that the resource takes", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    await runtime.nextProcess(
      "second",
      declare(types, { secrets: [{ name: "a", label: "new" }] }),
    );
    expect(provider.updateState).toEqual({ name: "a" });
    runtime.close();
  });
});

describe("a hidden param that takes a credential", () => {
  it("fails the plan", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const resources = declare(types, { secrets: ["a"] });
    (resources[1]!.schema as any).Value = {
      ...resources[1]!.schema.Value,
      hidden: true,
    };
    const runtime = createRuntime();
    await expect(
      createPlan({
        app: "app",
        stage: "test",
        resources,
        state: runtime.state,
      }),
    ).rejects.toThrow("Value is a hidden param");
    runtime.close();
  });
});

describe("an update that does not change a credential", () => {
  it("does not rotate it", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    provider.calls.length = 0;

    await runtime.nextProcess(
      "second",
      declare(types, { secrets: [{ name: "a", label: "new" }] }),
    );

    expect(provider.calls).toEqual(["update a"]);
    expect(provider.secrets.get("a")).toBe("token-value-1");
    runtime.close();
  });
});

describe("an update that moves a credential to another binding", () => {
  type WorkerSchema = {
    Key: { name: string };
    CreateParams: { name: string; Secrets: Record<string, string> };
    UpdateParams: { Secrets: Record<string, string> };
    ReadResult: {};
  };

  // As a Worker does: a binding whose value is undefined keeps the value
  // that the Worker holds, and a binding that is not in Secrets is deleted.
  const defineWorker = (workers: Map<string, Record<string, string>>) =>
    resource<WorkerSchema>({
      type: "test/credentials/Worker",
      provider: "test",
    })
      .defineSchema({
        name: {
          propertyType: "param",
          presence: "required",
          immutable: true,
          primaryKey: true,
          value: v.string(),
        },
        Secrets: {
          propertyType: "param",
          presence: "required",
          sensitive: true,
          value: v.record(v.string(), v.string()),
        },
      } as const)
      .defineOperations({
        create: async (params) => {
          workers.set(params.name, { ...params.Secrets });
        },
        update: async (key, _patch, params) => {
          const stored = workers.get(key.name) ?? {};
          const next: Record<string, string> = {};
          for (const [binding, value] of Object.entries(params.Secrets)) {
            if (value !== undefined) next[binding] = value;
            else if (binding in stored) next[binding] = stored[binding]!;
          }
          workers.set(key.name, next);
        },
        delete: async (key) => {
          workers.delete(key.name);
        },
      });

  const declareWorker = (
    types: ReturnType<typeof defineResources>,
    Worker: ReturnType<typeof defineWorker>,
    bindings: string[],
  ): BaseResource[] => {
    const token = new types.Token("token", { config: { scope: "read" } });
    return [
      token,
      new Worker("worker", {
        config: {
          name: "worker",
          Secrets: Object.fromEntries(
            bindings.map((binding) => [binding, token.credentials.Value]),
          ),
        },
      }),
    ];
  };

  const plan = (resources: BaseResource[], runtime: Runtime) =>
    createPlan({
      app: "app",
      stage: "test",
      resources,
      state: runtime.state,
    });

  it("fails at plan and deploy, without rotate, when a binding is renamed", async () => {
    const workers = new Map<string, Record<string, string>>();
    const types = defineResources(createProvider(), { rotate: false });
    const Worker = defineWorker(workers);
    const runtime = createRuntime();
    await runtime.deploy("first", declareWorker(types, Worker, ["A"]));
    clearHeldCredentials();

    const renamed = () => declareWorker(types, Worker, ["B"]);
    const planned = await plan(renamed(), runtime).catch((e: Error) => e);
    const deployed = await runtime
      .deploy("second", renamed())
      .catch((e: Error) => e);

    expect(UnobtainableCredentialError.is(planned)).toBe(true);
    expect(UnobtainableCredentialError.is(deployed)).toBe(true);
    expect(workers.get("worker")).toEqual({ A: "token-value-1" });
    runtime.close();
  });

  it("rotates, with rotate, when a binding is renamed, and plans the rotate", async () => {
    const workers = new Map<string, Record<string, string>>();
    const types = defineResources(createProvider(), { rotate: true });
    const Worker = defineWorker(workers);
    const runtime = createRuntime();
    await runtime.deploy("first", declareWorker(types, Worker, ["A"]));
    clearHeldCredentials();

    const planned = await plan(declareWorker(types, Worker, ["B"]), runtime);
    await runtime.deploy("second", declareWorker(types, Worker, ["B"]));

    expect(planned.nodes[0]).toMatchObject({
      decision: "noop",
      rotates: ["Value"],
    });
    expect(workers.get("worker")).toEqual({ B: "token-value-2" });
    runtime.close();
  });

  it("rotates, with rotate, for a second binding of the same credential", async () => {
    const workers = new Map<string, Record<string, string>>();
    const types = defineResources(createProvider(), { rotate: true });
    const Worker = defineWorker(workers);
    const runtime = createRuntime();
    await runtime.deploy("first", declareWorker(types, Worker, ["A"]));
    clearHeldCredentials();

    const planned = await plan(
      declareWorker(types, Worker, ["A", "B"]),
      runtime,
    );
    await runtime.deploy("second", declareWorker(types, Worker, ["A", "B"]));

    expect(planned.nodes[0]).toMatchObject({
      decision: "noop",
      rotates: ["Value"],
    });
    expect(workers.get("worker")).toEqual({
      A: "token-value-2",
      B: "token-value-2",
    });
    runtime.close();
  });
});

describe("--credential", () => {
  const passed = async (
    types: ReturnType<typeof defineResources>,
    runtime: ReturnType<typeof createRuntime>,
    hash?: string,
  ) => {
    const resources = declare(types, { secrets: ["a"] });
    return runtime.nextProcess("second", resources, {
      replace: [],
      credential: [
        {
          id: "token",
          name: "Value",
          instanceHash: hash ?? (await tokenHash(runtime, resources[0]!)),
          variable: "TEST_TOKEN_VALUE",
        },
      ],
    });
  };
  const tokenHash = async (
    runtime: ReturnType<typeof createRuntime>,
    token: Parameters<typeof instanceHash>[1],
  ) => instanceHash("credentials", token, (await runtime.state.get("token"))!);

  beforeEach(() => {
    process.env.TEST_TOKEN_VALUE = "passed-value";
    return () => {
      delete process.env.TEST_TOKEN_VALUE;
    };
  });

  it("gives every resource that takes the credential the value, and keeps the resource", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    provider.calls.length = 0;

    await passed(types, runtime);

    expect(provider.calls).toEqual(["update a"]);
    expect(provider.secrets.get("a")).toBe("passed-value");
    runtime.close();
  });

  it("fails when the instance hash is not the one of the resource", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    provider.calls.length = 0;

    const error = await passed(types, runtime, "0badbeef").catch(
      (e: Error) => e,
    );

    const hash = await tokenHash(runtime, declare(types, { secrets: [] })[0]!);
    expect((error as Error).message).toBe(
      `token has the instance hash ${hash} in this stage, not 0badbeef.`,
    );
    expect(provider.calls).toEqual([]);
    runtime.close();
  });

  it("fails for a credential with rotate", async () => {
    const types = defineResources(createProvider(), { rotate: true });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));

    await expect(passed(types, runtime)).rejects.toThrow(
      "--credential is accepted only for a credential without rotate",
    );
    runtime.close();
  });

  it("fails when deploy replaces the credential's resource", async () => {
    const provider = createProvider();
    const types = defineResources(provider, { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    const overrides = {
      replace: [],
      credential: [
        {
          id: "token",
          name: "Value",
          instanceHash: await tokenHash(
            runtime,
            declare(types, { secrets: [] })[0]!,
          ),
          variable: "TEST_TOKEN_VALUE",
        },
      ],
    };
    const replaced = () => declare(types, { scope: "write", secrets: ["a"] });
    const message =
      "--credential token.Value cannot be given when deploy replaces token";
    provider.calls.length = 0;

    await expect(
      createPlan({
        app: "app",
        stage: "test",
        resources: replaced(),
        state: runtime.state,
        deploymentId: "credentials",
        overrides,
      }),
    ).rejects.toThrow(message);
    await expect(
      runtime.nextProcess("second", replaced(), overrides),
    ).rejects.toThrow(message);
    expect(provider.calls).toEqual([]);
    runtime.close();
  });

  it("fails when its variable is not set", async () => {
    const types = defineResources(createProvider(), { rotate: false });
    const runtime = createRuntime();
    await runtime.deploy("first", declare(types, { secrets: ["a"] }));
    delete process.env.TEST_TOKEN_VALUE;

    await expect(passed(types, runtime)).rejects.toThrow(
      "--credential token.Value reads TEST_TOKEN_VALUE, which is not set.",
    );
    runtime.close();
  });
});

describe("credentialVariable", () => {
  it("names a variable from the resource ID and credential name", () => {
    expect(credentialVariable("api-token", "Value")).toBe("API_TOKEN_VALUE");
  });

  it("starts with an underscore when the name would start with a digit", () => {
    expect(credentialVariable("1password:token", "Value")).toBe(
      "_1PASSWORD_TOKEN_VALUE",
    );
  });
});
