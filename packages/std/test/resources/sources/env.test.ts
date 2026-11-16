import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectResourceGraph,
  type BaseCredentialSource,
} from "@notation/resource";
import { Env, trackRevision, type Track } from "src/resources/sources";

const scope = { app: "shop", stage: "prod" };

async function declare(id: string, config: { key: string; track?: Track }) {
  const graph = await collectResourceGraph(() => {
    new Env(id, { config });
  });
  return graph.resources[0] as BaseCredentialSource;
}

function readContext(id: string, state?: { revision: string }) {
  const warnings: string[] = [];
  return {
    warnings,
    context: {
      ...scope,
      id,
      executionId: "exec-1",
      state,
      warn: (message: string) => warnings.push(message),
    },
  };
}

const loadContext = (id: string) => ({ ...scope, id, executionId: "exec-1" });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Env", () => {
  it("has the execution ID as its revision without track, and does not read the variable", async () => {
    vi.stubEnv("STRIPE_KEY", undefined);
    const source = await declare("stripe-key", { key: "STRIPE_KEY" });
    const { context, warnings } = readContext("stripe-key");

    await expect(
      source.readSource({ key: "STRIPE_KEY" }, context),
    ).resolves.toEqual({ revision: "exec-1" });
    expect(warnings).toEqual([]);
  });

  it("loads the variable", async () => {
    vi.stubEnv("STRIPE_KEY", "sk_live_1");
    const source = await declare("stripe-key", { key: "STRIPE_KEY" });

    await expect(
      source.loadCredential(
        { key: "STRIPE_KEY" },
        { revision: "exec-1" },
        loadContext("stripe-key"),
      ),
    ).resolves.toEqual({ value: "sk_live_1" });
  });

  it("fails to load a variable that is not set or is empty", async () => {
    const source = await declare("stripe-key", { key: "STRIPE_KEY" });
    const load = () =>
      source.loadCredential(
        { key: "STRIPE_KEY" },
        { revision: "exec-1" },
        loadContext("stripe-key"),
      );

    vi.stubEnv("STRIPE_KEY", undefined);
    await expect(load()).rejects.toThrow("STRIPE_KEY is not set.");
    vi.stubEnv("STRIPE_KEY", "");
    await expect(load()).rejects.toThrow("STRIPE_KEY is not set.");
  });

  describe("with track", () => {
    it("has a hash of the value as its revision, salted with the app, the stage and the ID", async () => {
      vi.stubEnv("NOTATION_TRACK_KEY", "track-key");
      vi.stubEnv("STRIPE_KEY", "sk_live_1");
      const params = { key: "STRIPE_KEY", track: "hmac" as const };
      const source = await declare("stripe-key", params);

      const { revision } = (await source.readSource(
        params,
        readContext("stripe-key").context,
      )) as { revision: string };

      expect(revision).toMatch(/^hmac:[0-9a-f]{64}$/);
      expect(revision).not.toContain("sk_live_1");
      await expect(
        trackRevision("hmac", { ...scope, id: "stripe-key" }, "sk_live_1"),
      ).resolves.toBe(revision);
      await expect(
        trackRevision("hmac", { ...scope, id: "other-key" }, "sk_live_1"),
      ).resolves.not.toBe(revision);
      await expect(
        trackRevision(
          "hmac",
          { ...scope, stage: "dev", id: "stripe-key" },
          "sk_live_1",
        ),
      ).resolves.not.toBe(revision);
      await expect(
        trackRevision("hmac", { ...scope, id: "stripe-key" }, "sk_live_2"),
      ).resolves.not.toBe(revision);

      vi.stubEnv("NOTATION_TRACK_KEY", "another-key");
      await expect(
        trackRevision("hmac", { ...scope, id: "stripe-key" }, "sk_live_1"),
      ).resolves.not.toBe(revision);
    });

    it("hashes with scrypt", async () => {
      vi.stubEnv("STRIPE_KEY", "sk_live_1");
      const params = { key: "STRIPE_KEY", track: "scrypt" as const };
      const source = await declare("stripe-key", params);

      const { revision } = (await source.readSource(
        params,
        readContext("stripe-key").context,
      )) as { revision: string };

      expect(revision).toMatch(/^scrypt:[0-9a-f]{64}$/);
      await expect(
        source.loadCredential(params, { revision }, loadContext("stripe-key")),
      ).resolves.toEqual({ value: "sk_live_1" });
    });

    it("fails with hmac when NOTATION_TRACK_KEY is not set, and names it", async () => {
      vi.stubEnv("NOTATION_TRACK_KEY", undefined);
      vi.stubEnv("STRIPE_KEY", "sk_live_1");
      const params = { key: "STRIPE_KEY", track: "hmac" as const };
      const source = await declare("stripe-key", params);

      await expect(
        source.readSource(params, readContext("stripe-key").context),
      ).rejects.toThrow("NOTATION_TRACK_KEY");
    });

    it("keeps the revision in state, and warns, when the variable is not set", async () => {
      vi.stubEnv("NOTATION_TRACK_KEY", "track-key");
      vi.stubEnv("STRIPE_KEY", undefined);
      const params = { key: "STRIPE_KEY", track: "hmac" as const };
      const source = await declare("stripe-key", params);
      const { context, warnings } = readContext("stripe-key", {
        revision: "hmac:recorded",
      });

      await expect(source.readSource(params, context)).resolves.toEqual({
        revision: "hmac:recorded",
      });
      expect(warnings).toEqual([
        "STRIPE_KEY is not set. Its value was not checked for a change.",
      ]);
      await expect(
        source.loadCredential(
          params,
          { revision: "hmac:recorded" },
          loadContext("stripe-key"),
        ),
      ).rejects.toThrow("STRIPE_KEY is not set.");
    });

    it("fails when the variable is not set and state has no revision", async () => {
      vi.stubEnv("NOTATION_TRACK_KEY", "track-key");
      vi.stubEnv("STRIPE_KEY", undefined);
      const params = { key: "STRIPE_KEY", track: "hmac" as const };
      const source = await declare("stripe-key", params);

      await expect(
        source.readSource(params, readContext("stripe-key").context),
      ).rejects.toThrow("STRIPE_KEY is not set.");
    });

    it("fails to load a value that changed after read", async () => {
      vi.stubEnv("NOTATION_TRACK_KEY", "track-key");
      vi.stubEnv("STRIPE_KEY", "sk_live_1");
      const params = { key: "STRIPE_KEY", track: "hmac" as const };
      const source = await declare("stripe-key", params);
      const { revision } = (await source.readSource(
        params,
        readContext("stripe-key").context,
      )) as { revision: string };

      await expect(
        source.loadCredential(params, { revision }, loadContext("stripe-key")),
      ).resolves.toEqual({ value: "sk_live_1" });
      vi.stubEnv("STRIPE_KEY", "sk_live_2");
      await expect(
        source.loadCredential(params, { revision }, loadContext("stripe-key")),
      ).rejects.toThrow("The value of stripe-key changed after deploy read it");
    });
  });
});
