import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import { CloudflareApiError } from "src/api/client";
import { ContainerApplication } from "src/resources/containers/container-application";
import { ContainerRegistry } from "src/resources/containers/container-registry";
import { WorkerScript } from "src/resources/workers/worker-script";

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
    dependencies: {} as any,
  });

  const params = {
    AccountId: "acc",
    Name: "app-dev-sandbox",
    HostedNamespaceId: "sandboxes",
    ScriptName: "app--dev--api",
    ClassName: "Sandbox",
    MaxInstances: 5,
    Configuration: {
      image: "registry.cloudflare.com/acc/sandbox:1",
      instance_type: "lite",
    },
  };

  const key = { AccountId: "acc", ApplicationId: "app1" };

  const NAMESPACES =
    "https://api.cloudflare.com/client/v4/accounts/acc/workers/durable_objects/namespaces";

  // Answers the first page of the namespace list with `namespaces`, and
  // later pages with an empty list.
  function mockApi(
    respond: (call: Call) => Response | Promise<Response>,
    namespaces: unknown[] = [
      { id: "ns0", class: "Sandbox", script: "another-worker" },
      { id: "ns1", class: "Sandbox", script: "app--dev--api" },
    ],
  ) {
    mockFetch((call) => {
      if (!call.url.startsWith(NAMESPACES)) return respond(call);
      return ok(call.url.includes("page=1&") ? namespaces : []);
    });
  }

  it("creates the application for the namespace that Cloudflare lists for the class, and returns its id", async () => {
    mockApi(() => ok({ id: "app1", name: params.Name }));

    await expect(application.create(params)).resolves.toEqual({
      ApplicationId: "app1",
    });
    expect(calls).toEqual([
      {
        method: "GET",
        url: `${NAMESPACES}?page=1&per_page=1000`,
        body: undefined,
      },
      {
        method: "POST",
        url: `${API}/applications`,
        body: {
          name: "app-dev-sandbox",
          scheduling_policy: "default",
          instances: 0,
          durable_objects: { namespace_id: "ns1" },
          configuration: params.Configuration,
          max_instances: 5,
        },
      },
    ]);
  });

  it("tries again, and makes nothing, while Cloudflare doesn't list a namespace for the class", async () => {
    mockApi(
      () => ok({ id: "app1" }),
      [{ id: "ns2", class: "Counter", script: "app--dev--api" }],
    );

    const error = await application.create(params).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceOperationPendingError);
    expect(error.message).toContain(
      "Cloudflare doesn't list a Durable Object namespace for the class Sandbox of the Worker app--dev--api yet",
    );
    expect(calls.map((call) => call.url)).toEqual([
      `${NAMESPACES}?page=1&per_page=1000`,
      `${NAMESPACES}?page=2&per_page=1000`,
    ]);
  });

  it("fails, and doesn't report the create as unknown, when the namespace list fails", async () => {
    mockFetch(() => fail(502, undefined, "bad gateway"));

    const error = await application.create(params).catch((e) => e);
    expect(error).not.toBeInstanceOf(ResourceCreationUnknownError);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("requests the next page after a page shorter than per_page, and stops at the page with the namespace", async () => {
    mockFetch((call) => {
      if (call.method === "POST") return ok({ id: "app1" });
      return call.url.includes("page=1&")
        ? ok([{ id: "other", class: "Sandbox", script: "another-worker" }])
        : ok([
            { id: "ns1", class: "Sandbox", script: "app--dev--api" },
            { id: "ns9", class: "Sandbox", script: "app--dev--api" },
          ]);
    });

    await application.create(params);

    expect(calls.map((call) => call.url)).toEqual([
      `${NAMESPACES}?page=1&per_page=1000`,
      `${NAMESPACES}?page=2&per_page=1000`,
      `${API}/applications`,
    ]);
    expect(calls[2]!.body).toMatchObject({
      durable_objects: { namespace_id: "ns1" },
    });
  });

  it("stops after 100 pages when Cloudflare never returns an empty page", async () => {
    mockFetch(() =>
      ok([{ id: "other", class: "Sandbox", script: "another-worker" }]),
    );

    await expect(application.create(params)).rejects.toThrow(
      "Cloudflare listed more than 100 pages of Durable Object namespaces",
    );
    expect(calls).toHaveLength(100);
  });

  it("skips the namespaces of previews and of dispatch namespaces with the same script and class", async () => {
    mockApi(
      () => ok({ id: "app1" }),
      [
        {
          id: "preview",
          class: "Sandbox",
          script: "app--dev--api",
          preview: {},
        },
        {
          id: "dispatched",
          class: "Sandbox",
          script: "app--dev--api",
          dispatch_namespace: "tenants",
        },
        { id: "ns1", class: "Sandbox", script: "app--dev--api" },
        {
          id: "preview-after",
          class: "Sandbox",
          script: "app--dev--api",
          preview: {},
        },
      ],
    );

    await application.create(params);

    expect(calls[1]!.body).toMatchObject({
      durable_objects: { namespace_id: "ns1" },
    });
  });

  it("reports a create whose response was a server error as unknown", async () => {
    mockApi(() => fail(502, undefined, "bad gateway"));

    await expect(application.create(params)).rejects.toBeInstanceOf(
      ResourceCreationUnknownError,
    );
  });

  it("finds the application with the name and the namespace after an unknown create", async () => {
    mockApi(() =>
      ok([
        { id: "other", name: params.Name, durable_objects: null },
        {
          id: "app1",
          name: params.Name,
          durable_objects: { namespace_id: "ns1" },
        },
      ]),
    );

    await expect(application.find!(params)).resolves.toEqual({
      ApplicationId: "app1",
    });
    expect(calls[1]).toMatchObject({
      method: "GET",
      url: `${API}/applications`,
    });
  });

  it("finds nothing when no application has the name and the namespace", async () => {
    mockApi(() =>
      ok([{ id: "x", name: "x", durable_objects: { namespace_id: "ns1" } }]),
    );

    await expect(application.find!(params)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it("finds nothing, without listing the applications, when Cloudflare lists no namespace for the class", async () => {
    mockApi(() => ok([{ id: "app1", name: params.Name }]), []);

    await expect(application.find!(params)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    expect(calls).toHaveLength(1);
  });

  it("tries again while Cloudflare can't see a new namespace", async () => {
    mockApi(() =>
      fail(400, 1000, "The provided Durable Object namespace was not found"),
    );

    const error = await application.create(params).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceOperationPendingError);
    expect(error.message).toContain(
      "Cloudflare can't find the Durable Object namespace ns1 yet",
    );
  });

  it("tries again while Cloudflare doesn't treat the namespace as a container namespace", async () => {
    mockApi(() => fail(400, 1607, "DURABLE_OBJECT_NOT_CONTAINER_ENABLED"));

    const error = await application.create(params).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceOperationPendingError);
    expect(error.retryAfterMs).toBe(5_000);
    expect(error.cause).toBeInstanceOf(CloudflareApiError);
    expect(error.message).toContain(
      "The upload of the Worker app--dev--api declared the class Sandbox as a container class, but Cloudflare doesn't treat the Durable Object namespace ns1 as a container namespace yet",
    );
  });

  it("reports a 500 that says Cloudflare can't create the application at this time as unknown", async () => {
    mockApi(() => fail(500, 1000, "can't create application at this time"));

    await expect(application.create(params)).rejects.toBeInstanceOf(
      ResourceCreationUnknownError,
    );
  });

  it("fails with a message that says what to do when the namespace already has an application", async () => {
    mockApi(() => fail(400, 1608, "DURABLE_OBJECT_ALREADY_HAS_APPLICATION"));

    const error = await application.create(params).catch((e) => e);
    expect(error).not.toBeInstanceOf(ResourceCreationUnknownError);
    expect(error.message).toContain(
      "already has a container application, and a namespace can have only one",
    );
  });

  it("reads the settings", async () => {
    mockFetch(() =>
      ok({
        id: "app1",
        name: params.Name,
        max_instances: 5,
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
          step_percentage: 25,
          target_configuration: configuration,
        },
      },
    ]);
  });

  it("only rolls out the patch's configuration when only the configuration changed", async () => {
    mockFetch(() => ok({}));
    const configuration = { image: "img:3" };

    await application.update!(
      key,
      { Configuration: configuration } as any,
      params,
      {} as any,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: { target_configuration: configuration },
    });
  });

  it("only patches when only the max instances changed", async () => {
    mockFetch(() => ok({}));

    await application.update!(
      key,
      { MaxInstances: 10 } as any,
      params,
      {} as any,
    );

    expect(calls.map((call) => call.method)).toEqual(["PATCH"]);
  });

  // Rolls out `desired` over `previous`, and returns the target it sent.
  async function rollOut(previous: object, desired: object) {
    mockFetch(() => ok({}));
    await application.update!(
      key,
      { Configuration: desired } as any,
      { ...params, Configuration: desired as any },
      { ...params, Configuration: previous } as any,
    );
    return (calls[0]!.body as any).target_configuration;
  }

  it("clears the environment variables and the network that the new configuration leaves out", async () => {
    const target = await rollOut(
      {
        image: "img:1",
        environment_variables: [{ name: "A", value: "1" }],
        network: { mode: "private" },
      },
      { image: "img:2" },
    );

    expect(target).toEqual({
      image: "img:2",
      environment_variables: [],
      network: {},
    });
  });

  it("sends the configuration as it is when no key was removed", async () => {
    const configuration = {
      image: "img:2",
      vcpu: 1,
      memory_mib: 4096,
      environment_variables: [{ name: "A", value: "2" }],
    };
    const target = await rollOut(
      { ...configuration, image: "img:1" },
      configuration,
    );

    expect(target).toEqual(configuration);
  });

  it.each([{ instance_type: "basic" }, { vcpu: 1, memory_mib: 4096 }])(
    "sets the lite instance type when %j is removed and no size is left",
    async (size) => {
      const target = await rollOut(
        { image: "img:1", ...size },
        {
          image: "img:1",
        },
      );

      expect(target).toEqual({ image: "img:1", instance_type: "lite" });
    },
  );

  it("sends no instance type when the configuration never set a size", async () => {
    const target = await rollOut({ image: "img:1" }, { image: "img:2" });

    expect(target).toEqual({ image: "img:2" });
  });

  it("sets the default disk size when vcpu and memory_mib replace an instance type", async () => {
    const target = await rollOut(
      { image: "img:1", instance_type: "basic" },
      { image: "img:1", vcpu: 1, memory_mib: 4096 },
    );

    expect(target).toEqual({
      image: "img:1",
      vcpu: 1,
      memory_mib: 4096,
      disk: { size_mb: 2000 },
    });
  });

  it("sends a declared disk size", async () => {
    const configuration = {
      image: "img:1",
      vcpu: 1,
      memory_mib: 3072,
      disk: { size_mb: 6000 },
    };
    const target = await rollOut(
      { image: "img:1", instance_type: "basic" },
      configuration,
    );

    expect(target).toEqual(configuration);
  });

  it("sets the default disk size when disk is removed", async () => {
    const target = await rollOut(
      { image: "img:1", vcpu: 1, memory_mib: 3072, disk: { size_mb: 6000 } },
      { image: "img:1", vcpu: 1, memory_mib: 3072 },
    );

    expect(target).toEqual({
      image: "img:1",
      vcpu: 1,
      memory_mib: 3072,
      disk: { size_mb: 2000 },
    });
  });

  it.each([{}, { instance_type: "standard-1" }])(
    "sends no disk when disk and the custom size are replaced by %j",
    async (size) => {
      const target = await rollOut(
        { image: "img:1", vcpu: 1, memory_mib: 3072, disk: { size_mb: 6000 } },
        { image: "img:1", ...size },
      );

      expect(target).toEqual({
        image: "img:1",
        instance_type: "lite",
        ...size,
      });
    },
  );

  it("sets the default of a removed vcpu or memory_mib next to the other", async () => {
    expect(
      await rollOut(
        { image: "img:1", vcpu: 2, memory_mib: 8192 },
        { image: "img:1", memory_mib: 8192 },
      ),
    ).toEqual({ image: "img:1", vcpu: 0.0625, memory_mib: 8192 });
  });

  it("keeps vcpu and memory_mib out of the target when an instance type replaces them", async () => {
    const target = await rollOut(
      { image: "img:1", vcpu: 1, memory_mib: 4096 },
      { image: "img:1", instance_type: "basic" },
    );

    expect(target).toEqual({ image: "img:1", instance_type: "basic" });
  });
});

describe("ContainerApplication network mode", () => {
  const params = {
    AccountId: "acc",
    Name: "app-dev-sandbox",
    HostedNamespaceId: "sandboxes",
    ScriptName: "app--dev--api",
    ClassName: "Sandbox",
    MaxInstances: 1,
    Configuration: { image: "img:1" },
  };
  const reject = (
    previous: object,
    desired: object | undefined,
    replace = false,
  ) =>
    ContainerApplication.rejectChange!(
      { ...params, Configuration: previous as any },
      desired && { ...params, Configuration: desired as any },
      { replace },
    );

  it.each([
    [{ image: "img:1", network: { mode: "public" } }, { image: "img:1" }],
    [
      { image: "img:1" },
      { image: "img:1", network: { assign_ipv4: "predefined" } },
    ],
    [
      { image: "img:1", network: { mode: "private" } },
      { image: "img:1", network: { mode: "public" } },
    ],
  ])("rejects a change of the mode from %j to %j", (previous, desired) => {
    expect(reject(previous, desired)).toMatch(
      /Cloudflare can't change the network mode of the container application app-dev-sandbox .*also change Name/,
    );
  });

  it("allows a removed network whose mode was private", () => {
    expect(
      reject(
        { image: "img:1", network: { mode: "private" } },
        {
          image: "img:1",
        },
      ),
    ).toBeUndefined();
  });

  it("allows a change of the mode when the application is replaced or deleted", () => {
    const publicNetwork = { image: "img:1", network: { mode: "public" } };
    expect(reject(publicNetwork, { image: "img:1" }, true)).toBeUndefined();
    expect(reject(publicNetwork, undefined)).toBeUndefined();
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

  it("rejects an auth with a key that Cloudflare doesn't know", async () => {
    const validate = (value: unknown) =>
      registry.schema.Auth.value["~standard"].validate(value);
    expect(
      (await validate({ ...params.Auth, password: "x" })).issues,
    ).toBeDefined();
    expect(
      (
        await validate({
          ...params.Auth,
          private_credential: { ...params.Auth.private_credential, id: "x" },
        })
      ).issues,
    ).toBeDefined();
  });

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

    await expect(registry.read!(key)).resolves.toEqual(key);
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

  it("throws a failed delete with the error of the list as its cause when the list also fails", async () => {
    mockFetch((call) =>
      call.method === "DELETE"
        ? fail(404, 1000, "not found")
        : fail(500, undefined, "list failed"),
    );

    const error = await registry.delete(key, {} as any).catch((e) => e);
    expect(error.message).toContain("DELETE");
    expect(error.message).toContain("failed with status 404");
    expect(error.cause.message).toContain("list failed");
  });

  it.each(["docker.io", "123456789012.dkr.ecr.us-east-1.amazonaws.com"])(
    "accepts the domain %s",
    async (domain) => {
      const result =
        await registry.schema.Domain.value["~standard"].validate(domain);
      expect(result.issues).toBeUndefined();
    },
  );

  it.each(["https://docker.io", "docker.io/library", "Docker.io", ""])(
    "rejects the domain %j",
    async (domain) => {
      const result =
        await registry.schema.Domain.value["~standard"].validate(domain);
      expect(result.issues).toBeDefined();
    },
  );
});

describe("ContainerApplication namespace", () => {
  function deployedPair(hostedNamespaceId = "sandboxes", container = true) {
    const script = new WorkerScript("worker:api", {
      config: {
        CompatibilityDate: "2026-10-12",
        DurableObjectNamespaces: [
          { id: "counters", className: "Counter" },
          { id: "sandboxes", className: "Sandbox", container },
        ],
      },
      dependencies: {} as any,
    });
    const application = new ContainerApplication("app", {
      config: {
        Name: "app-dev-sandbox",
        HostedNamespaceId: hostedNamespaceId,
        MaxInstances: 1,
        Configuration: { image: "img:1" },
      },
      dependencies: { script },
    });
    script.setOutput({
      AccountId: "acc",
      ScriptName: "app--dev--api",
    } as typeof script.output);
    return { script, application };
  }

  beforeEach(() => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
  });

  it("depends on the Worker, and is deleted before a replaced Worker", () => {
    const { script, application } = deployedPair();

    expect(application.getDependencies()).toContain(script);
    expect(ContainerApplication.blocksDeleteOf).toEqual([WorkerScript.type]);
  });

  it("takes the Worker's name from its output, and the class of the hosted namespace from its config", async () => {
    const { application } = deployedPair();

    await expect(application.getParams()).resolves.toMatchObject({
      AccountId: "acc",
      HostedNamespaceId: "sandboxes",
      ScriptName: "app--dev--api",
      ClassName: "Sandbox",
    });
  });

  it("throws when the Worker hosts no namespace with the id", async () => {
    const { application } = deployedPair("rooms");

    await expect(application.getParams()).rejects.toThrow(
      'The Worker app--dev--api hosts no Durable Object namespace with the id "rooms"',
    );
  });

  it("throws, before any request, when the hosted namespace doesn't set container", async () => {
    mockFetch(() => ok());
    const { application } = deployedPair("sandboxes", false);

    await expect(application.getParams()).rejects.toThrow(
      'The Durable Object namespace for the class Sandbox can\'t run containers. Set `container: true` on the entry "sandboxes"',
    );
    expect(calls).toEqual([]);
  });
});

describe("ContainerApplication configuration", () => {
  const application = new ContainerApplication("app", {
    config: {} as any,
    dependencies: {} as any,
  });
  const validate = (value: unknown) =>
    application.schema.Configuration.value["~standard"].validate(value);

  it("rejects a key that Cloudflare doesn't know", async () => {
    const result = await validate({
      image: "img:1",
      network: { assignipv4: "predefined" },
    });
    expect(result.issues).toBeDefined();
  });

  it("rejects a key that is not supported", async () => {
    const result = await validate({ image: "img:1", command: ["sh"] });
    expect(result.issues).toBeDefined();
  });

  it.each([
    "app--dev--sandbox",
    "-sandbox",
    "sandbox-",
    "1sandbox",
    "",
    "a".repeat(254),
  ])("rejects the name %j, which Cloudflare refuses", async (name) => {
    const result =
      await application.schema.Name.value["~standard"].validate(name);
    expect(result.issues).toBeDefined();
  });

  it("accepts a name with single dashes", async () => {
    const result =
      await application.schema.Name.value["~standard"].validate(
        "app-dev-sandbox",
      );
    expect(result.issues).toBeUndefined();
  });

  it("rejects a max instances below 1", async () => {
    const result =
      await application.schema.MaxInstances.value["~standard"].validate(0);
    expect(result.issues).toBeDefined();
  });

  it("accepts a configuration with every supported key", async () => {
    const result = await validate({
      image: "img:1",
      vcpu: 1,
      memory_mib: 1024,
      disk: { size_mb: 4000 },
      environment_variables: [{ name: "A", value: "1" }],
      network: { assign_ipv4: "predefined", mode: "public" },
    });
    expect(result.issues).toBeUndefined();
  });

  it.each([{ instance_type: "basic" }, {}, { vcpu: 1 }, { memory_mib: 3072 }])(
    "rejects disk together with %j",
    async (size) => {
      const result = await validate({
        image: "img:1",
        ...size,
        disk: { size_mb: 4000 },
      });
      expect(result.issues).toBeDefined();
    },
  );

  it.each([511, 1000.5])("rejects a disk size of %j MB", async (size_mb) => {
    const result = await validate({
      image: "img:1",
      vcpu: 1,
      memory_mib: 3072,
      disk: { size_mb },
    });
    expect(result.issues).toBeDefined();
  });

  it("accepts a disk size of 512 MB", async () => {
    const result = await validate({
      image: "img:1",
      vcpu: 1,
      memory_mib: 3072,
      disk: { size_mb: 512 },
    });
    expect(result.issues).toBeUndefined();
  });

  it.each([{ vcpu: 1 }, { memory_mib: 1024 }])(
    "rejects instance_type together with %j",
    async (resources) => {
      const result = await validate({
        image: "img:1",
        instance_type: "basic",
        ...resources,
      });
      expect(result.issues).toBeDefined();
    },
  );

  it("accepts instance_type on its own", async () => {
    const result = await validate({ image: "img:1", instance_type: "basic" });
    expect(result.issues).toBeUndefined();
  });
});
