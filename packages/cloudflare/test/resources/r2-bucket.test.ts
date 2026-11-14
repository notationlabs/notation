import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResourceCreationUnknownError,
  ResourceNotFoundError,
} from "@notation/resource";
import { R2Bucket } from "src/resources/r2/r2-bucket";

type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};
let calls: Call[];

function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(url),
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body === undefined ? undefined : JSON.parse(init.body as any),
    };
    calls.push(call);
    return respond(call);
  });
}

function mockResponses(responses: Response[]) {
  mockFetch(() => responses.shift()!);
}

const ok = (result: unknown = null) =>
  Response.json({ success: true, errors: [], result });

const fail = (status: number, code: number | undefined, message = "failed") =>
  Response.json(
    { success: false, errors: [{ code, message }], result: null },
    { status },
  );

const noSuchBucket = () =>
  fail(404, 10006, "The specified bucket does not exist.");

const BUCKETS_URL =
  "https://api.cloudflare.com/client/v4/accounts/acc/r2/buckets";

const params = {
  AccountId: "acc",
  BucketName: "app--dev--uploads",
  Jurisdiction: "default" as const,
  StorageClass: "Standard" as const,
};

const { StorageClass: _, ...key } = params;

const bucket = new R2Bucket("bucket:uploads", {
  config: {
    BucketName: params.BucketName,
    Jurisdiction: params.Jurisdiction,
    StorageClass: params.StorageClass,
  },
});

beforeEach(() => {
  calls = [];
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("R2Bucket", () => {
  it("checks that the name is free, then creates the bucket", async () => {
    mockFetch((call) => (call.method === "GET" ? noSuchBucket() : ok({})));

    await bucket.create({ ...params, LocationHint: "weur" });

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${BUCKETS_URL}/app--dev--uploads`],
      ["POST", BUCKETS_URL],
    ]);
    expect(calls[1]!.body).toEqual({
      name: "app--dev--uploads",
      locationHint: "weur",
      storageClass: "Standard",
    });
    expect(calls[1]!.headers["cf-r2-jurisdiction"]).toBe("default");
  });

  it("doesn't keep the location hint in state, so a change to it doesn't replace the bucket", () => {
    const output = { ...params, LocationHint: "weur" as const };

    expect(bucket.toState(output)).not.toHaveProperty("LocationHint");
    expect(bucket.toComparable(output)).not.toHaveProperty("LocationHint");
  });

  it("sends the jurisdiction header on every request", async () => {
    const euParams = { ...params, Jurisdiction: "eu" as const };
    const { StorageClass: _, ...euKey } = euParams;
    mockResponses([
      noSuchBucket(),
      ok({}),
      ok({ storage_class: "Standard" }),
      ok({}),
      ok({}),
    ]);

    await bucket.create(euParams);
    await bucket.read!(euKey);
    await bucket.update!(euKey, {} as any, euParams, euParams);
    await bucket.delete(euKey, {} as any);

    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.headers["cf-r2-jurisdiction"]).toBe("eu");
    }
  });

  it("doesn't take over a bucket that exists already", async () => {
    mockFetch(() => ok({ name: "app--dev--uploads" }));

    await expect(bucket.create(params)).rejects.toThrow(
      "A bucket named app--dev--uploads already exists in the default jurisdiction of the Cloudflare account acc. Give the bucket another name",
    );
    expect(calls).toHaveLength(1);
  });

  it("fails with Cloudflare's message for an invalid name", async () => {
    mockFetch((call) =>
      call.method === "GET"
        ? noSuchBucket()
        : fail(400, 10005, "The specified bucket name is not valid."),
    );

    const error = await bucket.create(params).catch((e) => e);
    expect(error).not.toBeInstanceOf(ResourceCreationUnknownError);
    expect(error.message).toContain(
      "The specified bucket name is not valid. (10005)",
    );
  });

  it("reports a create whose response was a server error as unknown", async () => {
    mockFetch((call) =>
      call.method === "GET" ? noSuchBucket() : fail(500, 10001, "internal"),
    );

    await expect(bucket.create(params)).rejects.toBeInstanceOf(
      ResourceCreationUnknownError,
    );
  });

  it("fails, and doesn't report the create as unknown, when the check for an existing bucket fails", async () => {
    mockFetch(() => fail(502, undefined, "bad gateway"));

    const error = await bucket.create(params).catch((e) => e);
    expect(error).not.toBeInstanceOf(ResourceCreationUnknownError);
    expect(error.message).toContain("failed with status 502");
    expect(calls).toHaveLength(1);
  });

  it("reads the storage class", async () => {
    mockFetch(() =>
      ok({
        name: "app--dev--uploads",
        jurisdiction: "default",
        location: "WEUR",
        storage_class: "InfrequentAccess",
      }),
    );

    await expect(bucket.read!(key)).resolves.toEqual({
      ...key,
      StorageClass: "InfrequentAccess",
    });
  });

  it("reads a bucket without a storage class as Standard", async () => {
    mockFetch(() => ok({ name: "app--dev--uploads" }));

    await expect(bucket.read!(key)).resolves.toEqual({
      ...key,
      StorageClass: "Standard",
    });
  });

  it("accepts a 64-character bucket name", () => {
    const BucketName = "a".repeat(64);
    expect(
      () =>
        new R2Bucket("bucket:long", {
          config: { ...bucket.config, BucketName },
        }),
    ).not.toThrow();
  });

  it.each([
    "ab",
    "-uploads",
    "uploads-",
    "Uploads",
    "up_loads",
    "a".repeat(65),
  ])("rejects the bucket name %s when it is declared", (BucketName) => {
    expect(
      () =>
        new R2Bucket("bucket:invalid", {
          config: { ...bucket.config, BucketName },
        }),
    ).toThrow("An R2 bucket name must be 3 to 64 lowercase letters");
  });

  it.each([
    ["AccountId", /An R2 bucket can't move to another account/],
    ["BucketName", /An R2 bucket can't be renamed/],
    ["Jurisdiction", /An R2 bucket can't move to another jurisdiction/],
  ] as const)("rejects a replacement when %s changes", (name, message) => {
    const item = bucket.schema[name];
    if (item.propertyType !== "param") throw new Error("not a param");

    expect((item.rejectReplace as any)?.("old", "new")).toMatch(message);
  });

  it("reads a missing bucket as not found, and deletes it without an error", async () => {
    mockFetch(() => noSuchBucket());

    await expect(bucket.read!(key)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
    await expect(bucket.delete(key, {} as any)).resolves.toBeUndefined();
  });

  it("doesn't read a 404 with another code as not found", async () => {
    mockFetch(() => fail(404, 7003, "No route for that URI"));

    const error = await bucket.read!(key).catch((e) => e);
    expect(error).not.toBeInstanceOf(ResourceNotFoundError);
    expect(error.message).toContain("No route for that URI (7003)");
    await expect(bucket.delete(key, {} as any)).rejects.toThrow(
      "No route for that URI (7003)",
    );
  });

  it("sets the storage class in a header", async () => {
    mockFetch(() => ok({}));

    await bucket.update!(
      key,
      { StorageClass: "InfrequentAccess" } as any,
      { ...params, StorageClass: "InfrequentAccess" },
      params,
    );

    expect(calls[0]).toMatchObject({
      method: "PATCH",
      url: `${BUCKETS_URL}/app--dev--uploads`,
      body: undefined,
    });
    expect(calls[0]!.headers["cf-r2-storage-class"]).toBe("InfrequentAccess");
  });

  it("fails an update of a bucket that is gone", async () => {
    mockFetch(() => noSuchBucket());

    await expect(
      bucket.update!(key, {} as any, params, params),
    ).rejects.toThrow("The specified bucket does not exist. (10006)");
  });

  it("says to delete the objects when the bucket is not empty", async () => {
    mockFetch(() =>
      fail(409, undefined, "The bucket you tried to delete is not empty."),
    );

    await expect(bucket.delete(key, {} as any)).rejects.toThrow(
      "The bucket app--dev--uploads in the default jurisdiction of the Cloudflare account acc still has objects, and Cloudflare deletes only an empty bucket. Delete its objects, then try again.",
    );
  });

  it("takes the account from CLOUDFLARE_ACCOUNT_ID", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");

    await expect(bucket.getParams()).resolves.toEqual({
      ...params,
      AccountId: "acc",
    });
  });
});
