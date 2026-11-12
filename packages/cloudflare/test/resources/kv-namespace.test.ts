import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResourceCreationUnknownError,
  ResourceNotFoundError,
} from "@notation/resource";
import { KVNamespace } from "src/resources/kv/kv-namespace";

type Call = { method: string; url: string; body: unknown };
let calls: Call[];

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(url),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  });
}

const ok = (result: unknown = null) =>
  Response.json({ success: true, errors: [], result });

const fail = (status: number, code: number, message = "failed") =>
  Response.json(
    { success: false, errors: [{ code, message }], result: null },
    { status },
  );

const API = "https://api.cloudflare.com/client/v4/accounts/acc";

const params = { AccountId: "acc", Title: "app--dev--cache" };
const key = { AccountId: "acc", NamespaceId: "ns1" };

const namespace = new KVNamespace("kv:cache", {
  config: { Title: params.Title },
});

const isList = (call: Call) =>
  call.method === "GET" && call.url.includes("/namespaces?");

beforeEach(() => {
  calls = [];
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("KVNamespace", () => {
  it("checks the title is free, then creates the namespace", async () => {
    mockFetch((call) =>
      isList(call) ? ok([]) : ok({ id: "ns1", title: params.Title }),
    );

    await expect(
      namespace.create({ ...params, Jurisdiction: "eu" }),
    ).resolves.toEqual({ NamespaceId: "ns1" });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${API}/storage/kv/namespaces?page=1&per_page=1000`,
      `POST ${API}/storage/kv/namespaces`,
    ]);
    expect(calls[1]!.body).toEqual({ title: params.Title, jurisdiction: "eu" });
  });

  it("doesn't take over a namespace that has the title already", async () => {
    mockFetch(() => ok([{ id: "other", title: params.Title }]));

    await expect(namespace.create(params)).rejects.toThrow(
      'The Cloudflare account acc already has a KV namespace titled "app--dev--cache". Give this namespace another title',
    );
    expect(calls).toHaveLength(1);
  });

  it("reports a create whose response was a server error as unknown", async () => {
    mockFetch((call) => (isList(call) ? ok([]) : fail(502, 0, "bad gateway")));

    await expect(namespace.create(params)).rejects.toBeInstanceOf(
      ResourceCreationUnknownError,
    );
  });

  it("reports a create that timed out as unknown", async () => {
    mockFetch((call) => {
      if (isList(call)) return ok([]);
      throw new DOMException("The operation timed out.", "TimeoutError");
    });

    await expect(namespace.create(params)).rejects.toBeInstanceOf(
      ResourceCreationUnknownError,
    );
  });

  it("fails, and doesn't report the create as unknown, when the check for the title fails", async () => {
    mockFetch(() => fail(502, 0, "bad gateway"));

    const error = await namespace.create(params).catch((e) => e);
    expect(error).not.toBeInstanceOf(ResourceCreationUnknownError);
    expect(calls).toHaveLength(1);
  });

  it("finds the namespace that a create with an unknown outcome made, on a later page", async () => {
    const page = (n: number) =>
      Array.from({ length: 1000 }, (_, i) => ({
        id: `id-${n}-${i}`,
        title: `other-${n}-${i}`,
      }));
    mockFetch((call) =>
      call.url.includes("page=1&")
        ? ok(page(1))
        : ok([{ id: "ns1", title: params.Title }]),
    );

    await expect(namespace.find!(params, "token")).resolves.toEqual({
      NamespaceId: "ns1",
    });
    expect(calls.map((call) => call.url)).toEqual([
      `${API}/storage/kv/namespaces?page=1&per_page=1000`,
      `${API}/storage/kv/namespaces?page=2&per_page=1000`,
    ]);
  });

  it("finds nothing when no namespace has the title", async () => {
    mockFetch(() => ok([{ id: "other", title: "other" }]));

    await expect(namespace.find!(params, "token")).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    expect(calls).toHaveLength(1);
  });

  it("reads the title, jurisdiction and mode", async () => {
    mockFetch(() =>
      ok({ id: "ns1", title: params.Title, jurisdiction: "eu", mode: null }),
    );

    await expect(namespace.read!(key)).resolves.toEqual({
      ...key,
      Title: params.Title,
      Jurisdiction: "eu",
      Mode: undefined,
    });
    expect(calls[0]!.url).toBe(`${API}/storage/kv/namespaces/ns1`);
  });

  it("reads a missing namespace as not found, and deletes it without an error", async () => {
    mockFetch(() => fail(404, 10013, "namespace not found"));

    await expect(namespace.read!(key)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    await expect(namespace.delete(key, {} as any)).resolves.toBeUndefined();
    expect(calls[1]!.method).toBe("DELETE");
  });

  it("doesn't read a 404 without the not-found code as not found", async () => {
    mockFetch(() => fail(404, 7003, "Could not route to /accounts/acc"));

    const error = await namespace.read!(key).catch((e) => e);
    expect(error).not.toBeInstanceOf(ResourceNotFoundError);
    expect(error.message).toContain("failed with status 404");
    await expect(namespace.delete(key, {} as any)).rejects.toThrow(
      "failed with status 404",
    );
  });

  it("fails a delete that Cloudflare doesn't allow", async () => {
    mockFetch(() => fail(405, 10405, "Method not allowed"));

    await expect(namespace.delete(key, {} as any)).rejects.toThrow(
      "Method not allowed (10405)",
    );
  });

  it("renames the namespace", async () => {
    mockFetch(() => ok({ id: "ns1", title: "new" }));

    await namespace.update!(
      key,
      { Title: "new" } as any,
      { ...params, Title: "new" },
      { ...key, ...params } as any,
    );

    expect(calls).toEqual([
      {
        method: "PUT",
        url: `${API}/storage/kv/namespaces/ns1`,
        body: { title: "new" },
      },
    ]);
  });

  it("explains the error when a rename takes another namespace's title", async () => {
    mockFetch(() => fail(400, 10014, "a namespace with this title exists"));

    await expect(
      namespace.update!(
        key,
        { Title: "taken" } as any,
        { ...params, Title: "taken" },
        { ...key, ...params } as any,
      ),
    ).rejects.toThrow('already has a KV namespace titled "taken"');
  });

  it("fails a rename of a namespace that doesn't exist", async () => {
    mockFetch(() => fail(404, 10013, "namespace not found"));

    await expect(
      namespace.update!(
        key,
        { Title: "new" } as any,
        { ...params, Title: "new" },
        { ...key, ...params } as any,
      ),
    ).rejects.toThrow("namespace not found (10013)");
  });

  it("rejects a replacement when the jurisdiction changes", () => {
    const { Jurisdiction } = namespace.schema;
    if (Jurisdiction.propertyType !== "param") throw new Error("not a param");

    expect(Jurisdiction.rejectReplace?.(undefined, "eu")).toMatch(
      /The jurisdiction of this KV namespace is not set, and the code sets it to eu/,
    );
  });
});
