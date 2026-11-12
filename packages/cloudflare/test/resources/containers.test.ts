import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import { ContainerApplication } from "src/resources/containers/container-application";
import { ContainerRegistry } from "src/resources/containers/container-registry";

type Call = { method: string; url: string; body: unknown };
let calls: Call[];

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(url),
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return respond(call);
  });
}

const ok = (result: unknown = null) =>
  Response.json({ success: true, errors: [], result });

const fail = (status: number, code: number | undefined, message = "failed") =>
  Response.json(
    { success: false, errors: [{ code, message }], result: null },
    { status },
  );

const API = "https://api.cloudflare.com/client/v4/accounts/acc/containers";

beforeEach(() => {
  calls = [];
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("ContainerApplication", () => {
  const application = new ContainerApplication("app", {
    config: {} as any,
  });

  const params = {
    AccountId: "acc",
    Name: "app--dev--sandbox",
    DurableObjectNamespaceId: "ns1",
    MaxInstances: 5,
    Configuration: {
      image: "registry.cloudflare.com/acc/sandbox:1",
      instance_type: "lite",
    },
    Instances: 0,
  };

  const key = { AccountId: "acc", ApplicationId: "app1" };

  it("creates the application for the namespace and returns its id", async () => {
    mockFetch(() => ok({ id: "app1", name: params.Name }));

    await expect(application.create(params)).resolves.toEqual({
      ApplicationId: "app1",
    });
    expect(calls).toEqual([
      {
        method: "POST",
        url: `${API}/applications`,
        body: {
          name: "app--dev--sandbox",
          durable_objects: { namespace_id: "ns1" },
          configuration: params.Configuration,
          max_instances: 5,
          instances: 0,
        },
      },
    ]);
  });

  it("reports a create whose response was a server error as unknown", async () => {
    mockFetch(() => fail(502, undefined, "bad gateway"));

    await expect(application.create(params)).rejects.toBeInstanceOf(
      ResourceCreationUnknownError,
    );
  });

  it("finds the application with the name and the namespace after an unknown create", async () => {
    mockFetch(() =>
      ok([
        { id: "other", name: params.Name, durable_objects: null },
        {
          id: "app1",
          name: params.Name,
          durable_objects: { namespace_id: "ns1" },
        },
      ]),
    );

    await expect(application.find!(params, "token")).resolves.toEqual({
      ApplicationId: "app1",
    });
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: `${API}/applications`,
    });
  });

  it("finds nothing when no application has the name and the namespace", async () => {
    mockFetch(() =>
      ok([{ id: "x", name: "x", durable_objects: { namespace_id: "ns1" } }]),
    );

    await expect(application.find!(params, "token")).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it("tries again while Cloudflare can't see a new namespace", async () => {
    mockFetch(() =>
      fail(400, 1000, "The provided Durable Object namespace was not found"),
    );

    const error = await application.create(params).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceOperationPendingError);
    expect(error.message).toContain(
      "check that DurableObjectNamespaceId is the ID of a namespace",
    );
  });

  it("tries again when Cloudflare can't create an application at this time", async () => {
    mockFetch(() => fail(500, 1000, "can't create application at this time"));

    await expect(application.create(params)).rejects.toBeInstanceOf(
      ResourceOperationPendingError,
    );
  });

  it.each([
    [
      1608,
      "DURABLE_OBJECT_ALREADY_HAS_APPLICATION",
      "already has a container application, and a namespace can have only one",
    ],
    [
      1607,
      "DURABLE_OBJECT_NOT_CONTAINER_ENABLED",
      "Declare its class as a container class in the Worker",
    ],
  ])(
    "fails with a message that says what to do for error %i",
    async (code, message, expected) => {
      mockFetch(() => fail(400, code, message));

      const error = await application.create(params).catch((e) => e);
      expect(error).not.toBeInstanceOf(ResourceCreationUnknownError);
      expect(error.message).toContain(expected);
    },
  );

  it("reads the settings, without nulls", async () => {
    mockFetch(() =>
      ok({
        id: "app1",
        name: params.Name,
        max_instances: 5,
        instances: 0,
        rollout_active_grace_period: null,
        durable_objects: { namespace_id: "ns1" },
        configuration: { image: params.Configuration.image, vcpu: 0.0625 },
      }),
    );

    await expect(application.read!(key)).resolves.toEqual({
      AccountId: "acc",
      ApplicationId: "app1",
      Name: params.Name,
      DurableObjectNamespaceId: "ns1",
      MaxInstances: 5,
      Instances: 0,
      RolloutActiveGracePeriod: undefined,
    });
    expect(calls[0]!.url).toBe(`${API}/applications/app1`);
  });

  it("reads a missing application as not found, and deletes it without an error", async () => {
    mockFetch(() =>
      fail(404, 1609, "APPLICATION_NOT_FOUND: Container application not found"),
    );

    await expect(application.read!(key)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    await expect(application.delete(key, {} as any)).resolves.toBeUndefined();
  });

  it("doesn't read a 404 without the not-found code as not found", async () => {
    mockFetch(() => fail(404, 7003, "Could not route to /accounts/acc/x"));

    const error = await application.read!(key).catch((e) => e);
    expect(error).not.toBeInstanceOf(ResourceNotFoundError);
    expect(error.message).toContain("Could not route");
    await expect(application.delete(key, {} as any)).rejects.toThrow(
      "Could not route",
    );
  });

  it("patches changed settings, and rolls out a changed configuration", async () => {
    mockFetch(() => ok({ id: "app1" }));
    const configuration = { ...params.Configuration, image: "img:2" };

    await application.update!(
      key,
      { MaxInstances: 10, Configuration: configuration } as any,
      { ...params, MaxInstances: 10, Configuration: configuration },
      {} as any,
    );

    expect(calls).toEqual([
      {
        method: "PATCH",
        url: `${API}/applications/app1`,
        body: { max_instances: 10 },
      },
      {
        method: "POST",
        url: `${API}/applications/app1/rollouts`,
        body: {
          description: "Deployed by notation",
          strategy: "rolling",
          kind: "full_auto",
          step_percentage: 100,
          target_configuration: configuration,
        },
      },
    ]);
  });

  it("only rolls out when only the configuration changed", async () => {
    mockFetch(() => ok({}));

    await application.update!(
      key,
      { Configuration: params.Configuration } as any,
      params,
      {} as any,
    );

    expect(calls.map((call) => call.method)).toEqual(["POST"]);
  });

  it("says to deploy again when the application to update is gone", async () => {
    mockFetch(() => fail(404, 1609, "Container application not found"));

    await expect(
      application.update!(key, { MaxInstances: 10 } as any, params, {} as any),
    ).rejects.toThrow(
      "It may have been deleted outside notation. Deploy again to create it.",
    );
  });
});

describe("ContainerRegistry", () => {
  const registry = new ContainerRegistry("registry", { config: {} as any });

  const params = {
    AccountId: "acc",
    Domain: "docker.io",
    Kind: "DockerHub" as const,
    Auth: {
      private_credential: { store_id: "store", secret_name: "DOCKER_TOKEN" },
      public_credential: "me",
    },
  };

  const key = { AccountId: "acc", Domain: "docker.io" };

  it("configures the registry after it checks that none is configured", async () => {
    mockFetch((call) => (call.method === "GET" ? ok([]) : ok({})));

    await registry.create(params);

    expect(calls).toEqual([
      { method: "GET", url: `${API}/registries`, body: undefined },
      {
        method: "POST",
        url: `${API}/registries`,
        body: { domain: "docker.io", kind: "DockerHub", auth: params.Auth },
      },
    ]);
  });

  it("doesn't take over a registry that is configured already", async () => {
    mockFetch(() => ok([{ domain: "docker.io", kind: "DockerHub" }]));

    await expect(registry.create(params)).rejects.toThrow(
      "already has credentials for the registry docker.io",
    );
    expect(calls).toHaveLength(1);
  });

  it("reports a create whose response was a server error as unknown", async () => {
    mockFetch((call) =>
      call.method === "GET" ? ok([]) : fail(502, undefined, "bad gateway"),
    );

    await expect(registry.create(params)).rejects.toBeInstanceOf(
      ResourceCreationUnknownError,
    );
  });

  it("reads the registry from the list, and reads one that is not listed as not found", async () => {
    mockFetch(() => ok([{ domain: "docker.io", kind: "DockerHub" }]));

    await expect(registry.read!(key)).resolves.toEqual({
      ...key,
      Kind: "DockerHub",
    });
    await expect(
      registry.read!({ AccountId: "acc", Domain: "ghcr.io" }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("deletes the registry by its domain", async () => {
    mockFetch(() => ok({ domain: "docker.io" }));

    await registry.delete(key, {} as any);

    expect(calls).toEqual([
      { method: "DELETE", url: `${API}/registries/docker.io`, body: undefined },
    ]);
  });

  it("treats a failed delete of a registry that is not listed as done", async () => {
    mockFetch((call) =>
      call.method === "DELETE" ? fail(404, 1000, "not found") : ok([]),
    );

    await expect(registry.delete(key, {} as any)).resolves.toBeUndefined();
  });

  it("throws a failed delete of a registry that is still listed", async () => {
    mockFetch((call) =>
      call.method === "DELETE"
        ? fail(404, 1000, "not found")
        : ok([{ domain: "docker.io" }]),
    );

    await expect(registry.delete(key, {} as any)).rejects.toThrow(
      "failed with status 404",
    );
  });
});

describe("ContainerApplication configuration", () => {
  const application = new ContainerApplication("app", { config: {} as any });
  const validate = (value: unknown) =>
    application.schema.Configuration.value["~standard"].validate(value);

  it("rejects a key that Cloudflare doesn't know", async () => {
    const result = await validate({
      image: "img:1",
      network: { assignipv4: "predefined" },
    });
    expect(result.issues).toBeDefined();
  });

  it("accepts a configuration with document values", async () => {
    const result = await validate({
      image: "img:1",
      disk: { size_mb: 2000 },
      ports: [{ name: "http", port: 8080 }],
    });
    expect(result.issues).toBeUndefined();
  });
});
