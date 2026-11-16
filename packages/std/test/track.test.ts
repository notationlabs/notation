import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackRevision } from "src/track";

const scope = { app: "shop", stage: "prod", id: "stripe-key" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("trackRevision", () => {
  it("hashes a value once for the process", async () => {
    vi.stubEnv("NOTATION_TRACK_KEY", "track-key");
    const createHmac = vi.spyOn(crypto, "createHmac");

    const first = trackRevision("hmac", scope, "sk_cache_1");
    const second = trackRevision("hmac", scope, "sk_cache_1");

    expect(second).toBe(first);
    await first;
    expect(createHmac).toHaveBeenCalledTimes(1);
  });

  it("hashes again when the track key changes", async () => {
    vi.stubEnv("NOTATION_TRACK_KEY", "track-key");
    const first = await trackRevision("hmac", scope, "sk_cache_2");
    vi.stubEnv("NOTATION_TRACK_KEY", "another-key");

    await expect(trackRevision("hmac", scope, "sk_cache_2")).resolves.not.toBe(
      first,
    );
  });

  it("drops a hash that failed, so the next call hashes again", async () => {
    vi.stubEnv("NOTATION_TRACK_KEY", "track-key");
    vi.spyOn(crypto, "createHmac").mockImplementationOnce(() => {
      throw new Error("hash failed");
    });

    await expect(trackRevision("hmac", scope, "sk_cache_3")).rejects.toThrow(
      "hash failed",
    );
    await expect(trackRevision("hmac", scope, "sk_cache_3")).resolves.toMatch(
      /^hmac:[0-9a-f]{64}$/,
    );
  });
});
