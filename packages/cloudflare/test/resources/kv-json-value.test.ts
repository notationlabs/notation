import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KVJsonValue } from "src/resources/kv/kv-json-value";
import { calls, fail, mockFetch, ok } from "../mock-api";

const NS =
  "https://api.cloudflare.com/client/v4/accounts/acc/storage/kv/namespaces/ns1";

const text = (body: string) => new Response(body);
const keyNotFound = () => fail(404, 10009, "get: 'key not found'");

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("KVJsonValue", () => {
  const kvJsonValue = new KVJsonValue("kv-json:flags", {
    config: { Key: "flags", Value: { b: [1, { d: 2, c: 3 }], a: null } },
    dependencies: {} as any,
  });
  const key = { AccountId: "acc", NamespaceId: "ns1", Key: "flags" };
  const value = { b: [1, { d: 2, c: 3 }], a: null };
  const sorted = '{"a":null,"b":[1,{"c":3,"d":2}]}';

  it("writes the value as JSON with sorted keys, and finishes when a read returns that text", async () => {
    let written: string | undefined;
    mockFetch(async (call) => {
      if (call.method === "PUT") {
        written = await ((call.body as FormData).get("value") as Blob).text();
        return ok({});
      }
      return written === undefined ? keyNotFound() : text(written);
    });

    await expect(
      kvJsonValue.create({ ...key, Value: value }),
    ).resolves.toBeUndefined();

    expect(written).toBe(sorted);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${NS}/values/flags`,
      `PUT ${NS}/values/flags`,
      `GET ${NS}/values/flags`,
    ]);
  });

  it("names KVJsonValue when the key already exists", async () => {
    mockFetch(() => text("{}"));

    await expect(kvJsonValue.create({ ...key, Value: value })).rejects.toThrow(
      `already has the key "flags". Give this KVJsonValue another key`,
    );
  });

  it("waits while a read after an update returns other text", async () => {
    mockFetch((call) => (call.method === "PUT" ? ok({}) : text("{}")));

    await expect(
      kvJsonValue.update!(
        key,
        { Value: value } as any,
        { ...key, Value: value },
        {} as any,
      ),
    ).rejects.toThrow(
      `The KV key "flags" of the KVJsonValue doesn't return the written value yet`,
    );
  });

  it("reads the stored text parsed", async () => {
    mockFetch(() => text(sorted));

    await expect(kvJsonValue.read!(key)).resolves.toEqual({
      ...key,
      Value: value,
    });
  });

  it("reads text that isn't JSON as a JSON string", async () => {
    mockFetch(() => text("not json"));

    await expect(kvJsonValue.read!(key)).resolves.toEqual({
      ...key,
      Value: "not json",
    });
  });
});
