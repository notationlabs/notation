import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeDurableRuntime, runDurableWorkflow } from "@notation/core";
import * as durable from "@notation/reconciler/durable";
import {
  collectResourceGraph,
  ResourceCreationUnknownError,
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import { deleteKVValue, getKVValue, putKVValue } from "src/api/kv";
import { KVNamespace } from "src/resources/kv/kv-namespace";
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

  it("keeps a leading byte order mark in a value", async () => {
    const stored = "﻿value";
    mockFetch(() => text(stored));

    await expect(getKVValue("acc", "ns1", "k")).resolves.toBe(stored);
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

});

describe("KVValue", () => {
  const kvValue = new KVValue("kv:config", {
    config: { Key: "config", Value: "v2" },
    dependencies: {} as any,
  });
  const key = { AccountId: "acc", NamespaceId: "ns1", Key: "config" };
  const params = { ...key, Value: "v2" };

  it("checks that the key is missing, writes the value, and finishes when a read returns it", async () => {
    let written = false;
    mockFetch((call) => {
      if (call.method === "PUT") {
        written = true;
        return ok({});
      }
      return written ? text("v2") : keyNotFound();
    });

    await expect(kvValue.create(params)).resolves.toBeUndefined();

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${NS}/values/config`,
      `PUT ${NS}/values/config`,
      `GET ${NS}/values/config`,
    ]);
    expect((await form(calls[1]!.body)).value).toBe("v2");
  });

  it("refuses a key that already exists, and doesn't write it", async () => {
    mockFetch(() => text("v1"));

    await expect(kvValue.create(params)).rejects.toThrow(
      `The KV namespace ns1 in the Cloudflare account acc already has the key "config".`,
    );
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("reports an unknown outcome when the write fails with a server error", async () => {
    mockFetch((call) =>
      call.method === "PUT"
        ? fail(500, 10001, "Internal error")
        : keyNotFound(),
    );

    await expect(kvValue.create(params)).rejects.toBeInstanceOf(
      ResourceCreationUnknownError,
    );
  });

  it("waits while a read after the write finds no key, then neither checks nor writes again", async () => {
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

  it("waits while the KV calls don't find a namespace that was just created", async () => {
    mockFetch(() => namespaceNotFound());

    const error = await kvValue.create(params).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceOperationPendingError);
    expect(error.message).toContain("The KV namespace ns1");
    expect(error.callbackContext).toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("keeps the write when the read after it doesn't find the namespace yet", async () => {
    let reads = 0;
    mockFetch((call) => {
      if (call.method === "PUT") return ok({});
      return reads++ === 0 ? keyNotFound() : namespaceNotFound();
    });

    const error = await kvValue.create(params).catch((e) => e);
    expect(error).toBeInstanceOf(ResourceOperationPendingError);
    expect(error.callbackContext).toEqual({ Written: true });
    expect(calls.map((call) => call.method)).toEqual(["GET", "PUT", "GET"]);
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

describe("KVValue in a deploy", () => {
  let directory: string;
  let runtime: NodeDurableRuntime;
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
        values.set(name, (await form(call.body)).value);
        return ok({});
      }
      if (!values.has(name)) return keyNotFound();
      if (call.method === "DELETE") {
        values.delete(name);
        return ok({});
      }
      return text(values.get(name)!);
    });
  }

  async function deploy(executionId: string, key: string) {
    const { resources } = await collectResourceGraph(
      () => {
        const namespace = new KVNamespace("config", {
          config: { Title: "config" },
        });
        new KVValue("config:routes", {
          config: { Key: key, Value: "v1" },
          dependencies: { namespace },
        });
      },
      { scope: { app: "shop", stage: "dev" } },
    );
    await runDurableWorkflow(
      { workflowId: "deploy", runtime, executionId },
      (step, id) =>
        durable.deploy(step, {
          executionId: id,
          resources,
          state: runtime.state,
          nameScope: { app: "shop", stage: "dev" },
        }),
    );
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "notation-cf-kv-"));
    runtime = new NodeDurableRuntime({
      deployment: { app: "shop", stage: "dev" },
      databasePath: path.join(directory, "workflows.db"),
    });
    values = new Map();
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");
    fakeKV();
  });

  afterEach(async () => {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("writes the new key before it deletes the old one when the key changes", async () => {
    await deploy("first", "routes");
    calls.length = 0;

    await deploy("second", "routes-v2");

    expect(values).toEqual(new Map([["routes-v2", "v1"]]));
    const writes = calls
      .filter((call) => call.method !== "GET")
      .map(
        (call) =>
          `${call.method} ${new URL(call.url).pathname.split("/").pop()}`,
      );
    expect(writes).toEqual(["PUT routes-v2", "DELETE routes"]);
  });

  it("keeps the old key when the new key already exists", async () => {
    await deploy("first", "routes");
    values.set("taken", "theirs");

    await expect(deploy("second", "taken")).rejects.toThrow(
      `already has the key "taken"`,
    );

    expect(values).toEqual(
      new Map([
        ["routes", "v1"],
        ["taken", "theirs"],
      ]),
    );
    expect((await runtime.state.get("config:routes"))?.params).toMatchObject({
      Key: "routes",
    });
  });
});
