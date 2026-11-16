import * as v from "valibot";
import { describe, expect, expectTypeOf, it } from "vitest";
import { KVJsonError, readKVJson } from "src/workers/kv-json";
import * as runtime from "src/workers/runtime";
import * as workers from "src/workers";

const Flags = v.object({
  features: v.record(v.string(), v.boolean()),
  since: v.optional(
    v.pipe(
      v.string(),
      v.transform((text) => new Date(text)),
    ),
  ),
});

// A KV binding whose keys hold `stored`, and that records each `get`.
function namespace(stored: Record<string, string>) {
  const gets: unknown[][] = [];
  return {
    gets,
    get: async (key: string, options?: unknown) => {
      gets.push([key, options]);
      return stored[key] ?? null;
    },
  } as any;
}

describe("readKVJson()", () => {
  it("returns the schema's output, and passes the get options", async () => {
    const kv = namespace({
      flags: '{"features":{"uploads":true},"since":"2026-01-01T00:00:00Z"}',
    });

    const flags = await readKVJson(kv, "flags", Flags, { cacheTtl: 300 });

    expect(flags).toEqual({
      features: { uploads: true },
      since: new Date("2026-01-01T00:00:00Z"),
    });
    expect(kv.gets).toEqual([["flags", { cacheTtl: 300, type: "text" }]]);
    expectTypeOf(flags).toEqualTypeOf<
      { features: Record<string, boolean>; since?: Date } | undefined
    >();
  });

  it("returns undefined for a missing key", async () => {
    await expect(
      readKVJson(namespace({}), "flags", Flags),
    ).resolves.toBeUndefined();
  });

  it("throws a KVJsonError that names the key when the text isn't JSON", async () => {
    const error = await readKVJson(
      namespace({ flags: "not json" }),
      "flags",
      Flags,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(KVJsonError);
    expect(error.message).toBe(`The value of the KV key "flags" is not JSON.`);
    expect(error.key).toBe("flags");
    expect(error.issues).toEqual([]);
  });

  it("throws a KVJsonError with the issues when the value fails the schema", async () => {
    const error = await readKVJson(
      namespace({ flags: '{"features":{"uploads":"yes"}}' }),
      "flags",
      Flags,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(KVJsonError);
    expect(error.message).toBe(
      `The value of the KV key "flags" does not match the schema: features.uploads: Invalid type: Expected boolean but received "yes"`,
    );
    expect(error.issues).toHaveLength(1);
  });

  it("is exported from the infra and the runtime entry points", () => {
    expect(runtime.readKVJson).toBe(readKVJson);
    expect(workers.readKVJson).toBe(readKVJson);
    expect(runtime.KVJsonError).toBe(KVJsonError);
  });
});
