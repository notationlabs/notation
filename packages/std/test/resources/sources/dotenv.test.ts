import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setConfigFile } from "@notation/core";
import {
  collectResourceGraph,
  type BaseCredentialSource,
} from "@notation/resource";
import { Dotenv } from "src/resources/sources";

const scope = { app: "shop", stage: "prod", id: "webhook-secret" };
const loadContext = { ...scope, executionId: "exec-1" };
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "notation-std-dotenv-"));
  setConfigFile(path.join(directory, "notation.config.ts"));
});

afterEach(async () => {
  setConfigFile(undefined);
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function declare(config: {
  path: string;
  key: string;
  track?: "hmac" | "scrypt";
}) {
  const graph = await collectResourceGraph(() => {
    new Dotenv("webhook-secret", { config });
  });
  return graph.resources[0] as BaseCredentialSource;
}

describe("Dotenv", () => {
  it("loads a key from a file relative to the project root", async () => {
    await writeFile(
      path.join(directory, ".env.local"),
      "WEBHOOK_SECRET=whsec_1\n",
    );
    const params = { path: ".env.local", key: "WEBHOOK_SECRET" };
    const source = await declare(params);

    await expect(
      source.readSource(params, {
        ...loadContext,
        state: undefined,
        warn: () => {},
      }),
    ).resolves.toEqual({ revision: "exec-1" });
    await expect(
      source.loadCredential({ ...params, revision: "exec-1" }, loadContext),
    ).resolves.toBe("whsec_1");
  });

  it("fails to load a key that is not in the file, or from a missing file", async () => {
    const params = { path: ".env.local", key: "WEBHOOK_SECRET" };
    const source = await declare(params);
    const load = () =>
      source.loadCredential({ ...params, revision: "exec-1" }, loadContext);

    await expect(load()).rejects.toThrow(
      "WEBHOOK_SECRET is not set in .env.local.",
    );
    await writeFile(path.join(directory, ".env.local"), "OTHER=1\n");
    await expect(load()).rejects.toThrow(
      "WEBHOOK_SECRET is not set in .env.local.",
    );
  });

  it("with track, hashes the value, and warns when the key is not set", async () => {
    vi.stubEnv("NOTATION_TRACK_KEY", "track-key");
    await writeFile(
      path.join(directory, ".env.local"),
      "WEBHOOK_SECRET=whsec_1\n",
    );
    const params = {
      path: ".env.local",
      key: "WEBHOOK_SECRET",
      track: "hmac" as const,
    };
    const source = await declare(params);
    const warnings: string[] = [];
    const read = (state?: { revision: string }) =>
      source.readSource(params, {
        ...loadContext,
        state,
        warn: (message) => warnings.push(message),
      }) as Promise<{ revision: string }>;

    const { revision } = await read();
    expect(revision).toMatch(/^hmac:/);
    await expect(
      source.loadCredential({ ...params, revision }, loadContext),
    ).resolves.toBe("whsec_1");

    await writeFile(path.join(directory, ".env.local"), "");
    await expect(read({ revision })).resolves.toEqual({ revision });
    expect(warnings).toEqual([
      "WEBHOOK_SECRET is not set in .env.local. Its value was not checked for a change.",
    ]);
  });
});
