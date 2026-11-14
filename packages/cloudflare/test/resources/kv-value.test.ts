import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import {
  deleteKVValue,
  deleteKVValues,
  getKVValue,
  putKVValue,
  putKVValues,
} from "src/api/kv";
import { KVValue } from "src/resources/kv/kv-value";
import { calls, fail, mockFetch, ok } from "../mock-api";

const NS =
  "https://api.cloudflare.com/client/v4/accounts/acc/storage/kv/namespaces/ns1";

const text = (body: string) => new Response(body);
const keyNotFound = () => fail(404, 10009, "get: 'key not found'");
const namespaceNotFound = () => fail(404, 10013, "namespace not found");

const form = async (body: unknown) => {
  const data = body as FormData;
  return {
    value: await (data.get("value") as Blob).text(),
    metadata: data.get("metadata"),
  };
};

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("KV value calls", () => {
  it("puts a string as it is, with the key encoded in the path", async () => {
    mockFetch(() => ok({}));

    await putKVValue("acc", "ns1", "routes/a b", "hello");

    expect(calls[0]).toMatchObject({
      method: "PUT",
      url: `${NS}/values/routes%2Fa%20b`,
    });
    expect(await form(calls[0]!.body)).toEqual({
      value: "hello",
      metadata: null,
    });
  });

  it("puts any other value as JSON, with metadata and an expiration", async () => {
    mockFetch(() => ok({}));

    await putKVValue(
      "acc",
      "ns1",
      "config",
      { routes: ["/a"] },
      { metadata: { v: 1 }, expiration: 1_900_000_000, expirationTtl: 120 },
    );

    expect(calls[0]!.url).toBe(
      `${NS}/values/config?expiration=1900000000&expiration_ttl=120`,
    );
    expect(await form(calls[0]!.body)).toEqual({
      value: '{"routes":["/a"]}',
      metadata: '{"v":1}',
    });
  });

  it("sends the line breaks of a value as they are", async () => {
    mockFetch(() => ok({}));

    await putKVValue("acc", "ns1", "k", "a\nb\rc");

    const sent = await new Response(calls[0]!.body as FormData).text();
    expect(sent).toContain("\r\n\r\na\nb\rc\r\n");
  });

  it("gets a value as text, even when the text looks like an API response", async () => {
    const stored = '{"success":false,"errors":[]}';
    mockFetch(() => text(stored));

    await expect(getKVValue("acc", "ns1", "k")).resolves.toBe(stored);
    expect(calls[0]).toMatchObject({ method: "GET", url: `${NS}/values/k` });
  });

  it("gets a value parsed as JSON", async () => {
    mockFetch(() => text('{"routes":["/a"]}'));

    await expect(getKVValue("acc", "ns1", "k", "json")).resolves.toEqual({
      routes: ["/a"],
    });
  });

  it("names the key when a value to parse as JSON isn't JSON", async () => {
    mockFetch(() => text("plain"));

    await expect(getKVValue("acc", "ns1", "k", "json")).rejects.toThrow(
      `The value of the KV key "k" isn't JSON`,
    );
  });

  it("gets undefined for a missing key, and throws for a missing namespace", async () => {
    mockFetch(() => keyNotFound());
    await expect(getKVValue("acc", "ns1", "k")).resolves.toBeUndefined();

    vi.restoreAllMocks();
    mockFetch(() => namespaceNotFound());
    await expect(getKVValue("acc", "ns1", "k")).rejects.toThrow(
      "namespace not found (10013)",
    );
  });

  it("retries a get that is rate limited", async () => {
    mockFetch(() => fail(429, 971, "Please wait"));

    await expect(getKVValue("acc", "ns1", "k")).rejects.toBeInstanceOf(
      ResourceOperationPendingError,
    );
  });

  it("deletes a value, and succeeds when the key is missing", async () => {
    mockFetch(() => keyNotFound());

    await expect(deleteKVValue("acc", "ns1", "k")).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "DELETE", url: `${NS}/values/k` });
  });

  it("puts values in bulk, in requests of 10,000 keys", async () => {
    mockFetch(() => ok({ successful_key_count: 1, unsuccessful_keys: [] }));
    const entries = Array.from({ length: 10_001 }, (_, i) => ({
      key: `k${i}`,
      value: i === 0 ? "text" : { i },
    }));
    entries[0] = { ...entries[0]!, expirationTtl: 60 } as any;

    await putKVValues("acc", "ns1", entries);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `PUT ${NS}/bulk`,
      `PUT ${NS}/bulk`,
    ]);
    const first = JSON.parse(calls[0]!.body as string);
    expect(first).toHaveLength(10_000);
    expect(first[0]).toEqual({ key: "k0", value: "text", expiration_ttl: 60 });
    expect(first[1]).toEqual({ key: "k1", value: '{"i":1}' });
    expect(JSON.parse(calls[1]!.body as string)).toEqual([
      { key: "k10000", value: '{"i":10000}' },
    ]);
  });

  it("deletes values in bulk", async () => {
    mockFetch(() => ok({ successful_key_count: 2, unsuccessful_keys: [] }));

    await deleteKVValues("acc", "ns1", ["a", "b"]);

    expect(calls[0]).toMatchObject({
      method: "POST",
      url: `${NS}/bulk/delete`,
    });
    expect(JSON.parse(calls[0]!.body as string)).toEqual(["a", "b"]);
  });

  it("sends no request for an empty bulk call", async () => {
    mockFetch(() => ok({}));

    await putKVValues("acc", "ns1", []);
    await deleteKVValues("acc", "ns1", []);

    expect(calls).toEqual([]);
  });

  it("throws when Cloudflare reports keys that a bulk call didn't change", async () => {
    mockFetch(() =>
      ok({ successful_key_count: 1, unsuccessful_keys: ["b", "c"] }),
    );

    await expect(
      putKVValues("acc", "ns1", [
        { key: "a", value: "1" },
        { key: "b", value: "2" },
        { key: "c", value: "3" },
      ]),
    ).rejects.toThrow(
      `Cloudflare didn't write 2 of the KV keys. Send them again: "b", "c"`,
    );
    await expect(deleteKVValues("acc", "ns1", ["b", "c"])).rejects.toThrow(
      "Cloudflare didn't delete 2 of the KV keys",
    );
  });
});

describe("KVValue", () => {
  const kvValue = new KVValue("kv:config", {
    config: { Key: "config", Value: "v2" },
    dependencies: {} as any,
  });
  const key = { AccountId: "acc", NamespaceId: "ns1", Key: "config" };
  const params = { ...key, Value: "v2" };

  it("writes the value, and finishes when a read returns it", async () => {
    mockFetch((call) => (call.method === "PUT" ? ok({}) : text("v2")));

    await expect(kvValue.create(params)).resolves.toBeUndefined();

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `PUT ${NS}/values/config`,
      `GET ${NS}/values/config`,
    ]);
    expect((await form(calls[0]!.body)).value).toBe("v2");
  });

  it("waits while a read after the write finds no key, and doesn't write again", async () => {
    mockFetch((call) => (call.method === "PUT" ? ok({}) : keyNotFound()));

    const error = await kvValue.create(params).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceOperationPendingError);
    expect(error.callbackContext).toEqual({ Written: true });

    calls.length = 0;
    vi.restoreAllMocks();
    mockFetch(() => text("v2"));
    await expect(
      kvValue.create(params, error.callbackContext),
    ).resolves.toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("waits while a read after an update returns the old value", async () => {
    mockFetch((call) => (call.method === "PUT" ? ok({}) : text("v1")));

    await expect(
      kvValue.update!(key, { Value: "v2" } as any, params, params as any),
    ).rejects.toBeInstanceOf(ResourceOperationPendingError);
    expect(calls.map((call) => call.method)).toEqual(["PUT", "GET"]);
  });

  it("reads the value", async () => {
    mockFetch(() => text("v1"));

    await expect(kvValue.read!(key)).resolves.toEqual({ ...key, Value: "v1" });
  });

  it("reads a missing key or namespace as not found", async () => {
    mockFetch(() => keyNotFound());
    await expect(kvValue.read!(key)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );

    vi.restoreAllMocks();
    mockFetch(() => namespaceNotFound());
    await expect(kvValue.read!(key)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it("deletes the key, and succeeds when its namespace is gone", async () => {
    mockFetch(() => ok({}));
    await kvValue.delete(key, params as any);
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      url: `${NS}/values/config`,
    });

    vi.restoreAllMocks();
    mockFetch(() => namespaceNotFound());
    await expect(kvValue.delete(key, params as any)).resolves.toBeUndefined();
  });

  it("fails a delete that Cloudflare refuses", async () => {
    mockFetch(() => fail(403, 10000, "Authentication error"));

    await expect(kvValue.delete(key, params as any)).rejects.toThrow(
      "Authentication error (10000)",
    );
  });
});
