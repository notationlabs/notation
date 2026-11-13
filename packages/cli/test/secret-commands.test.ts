import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRecordedSecrets,
  setConfigFile,
  type Deployment,
} from "@notation/core";
import { compileInfra, compileRuntimeModules } from "../src/compile";
import { deploy } from "../src/deploy";
import { secretDelete, secretSet } from "../src/secret";

const tmpDir = fileURLToPath(new URL("../tmp", import.meta.url));

function makeFakeTty(isTTY = true) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode: (mode: boolean) => void;
  };
  stdin.isTTY = isTTY;
  stdin.isRaw = false;
  stdin.setRawMode = vi.fn((mode: boolean) => {
    stdin.isRaw = mode;
  });

  const stderrChunks: string[] = [];
  const stderr = {
    isTTY,
    write: vi.fn((chunk: string | Uint8Array) => {
      stderrChunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }),
  };

  return {
    stdin,
    stderr,
    stderrText: () => stderrChunks.join(""),
  };
}

function readSqliteTables(dbPath: string): Record<string, unknown[]> {
  const db = new DatabaseSync(dbPath);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const out: Record<string, unknown[]> = {};
    for (const { name } of tables) {
      out[name] = db.prepare(`SELECT * FROM "${name}"`).all();
    }
    return out;
  } finally {
    db.close();
  }
}

describe("notation secret set / delete", () => {
  let root: string;
  let dbPath: string;
  const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const origApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const origDbPath = process.env.NOTATION_DATABASE_PATH;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    root = realpathSync(mkdtempSync(path.join(tmpDir, "notation-secret-cmd-")));
    dbPath = path.join(root, ".notation/workflows.db");
    writeFileSync(path.join(root, "notation.config.ts"), "export default {}");
    writeFileSync(
      path.join(root, "infra.ts"),
      `
      import { accountToken, secret } from "@notation/cloudflare";
      import { env } from "@notation/std/sources";

      export const adminPassword = secret({ id: "admin-password" });
      export const stripeKey = secret({
        id: "stripe-key",
        source: env,
        key: "STRIPE_KEY",
      });
      export const deployToken = accountToken({
        id: "deploy-token",
        policies: [
          {
            effect: "allow",
            permissionGroups: [{ id: "pg-1" }],
            resources: { "com.cloudflare.api.account.*": "*" },
          },
        ],
      });
      `,
    );
    setConfigFile(path.join(root, "notation.config.ts"));
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc-123";
    process.env.CLOUDFLARE_API_TOKEN = "tok-123";
    process.env.NOTATION_DATABASE_PATH = dbPath;
    clearRecordedSecrets();
  });

  afterEach(() => {
    setConfigFile(undefined);
    clearRecordedSecrets();
    globalThis.fetch = origFetch;
    if (origAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = origAccountId;
    if (origApiToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = origApiToken;
    if (origDbPath === undefined) delete process.env.NOTATION_DATABASE_PATH;
    else process.env.NOTATION_DATABASE_PATH = origDbPath;
    rmSync(root, { recursive: true, force: true });
  });

  const deployment = (): Deployment => ({
    app: "shop",
    stage: "dev",
    entryPoint: path.join(root, "infra.ts"),
    files: {},
  });

  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  async function seedSecretsStoreState(
    output: Record<string, unknown> = { StoreId: "store-1" },
  ) {
    const storeInfra = path.join(root, "store-only.ts");
    writeFileSync(
      storeInfra,
      `import { secret } from "@notation/cloudflare";\nexport const seed = secret({ id: "seed-secret" });\n`,
    );
    const savedFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const method = init?.method ?? "GET";
        if (
          url.endsWith("/secrets_store/stores?page=1&per_page=100") &&
          method === "GET"
        ) {
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ id: "store-1", name: "default_secrets_store" }],
            }),
          );
        }
        if (url.endsWith("/secrets_store/stores/store-1") && method === "GET") {
          return new Response(
            JSON.stringify({
              success: true,
              result: { id: "store-1", name: "default_secrets_store" },
            }),
          );
        }
        if (url.includes("/secrets?") && method === "GET") {
          return new Response(
            JSON.stringify({
              success: true,
              result: [
                {
                  id: "sec-seed",
                  name: "shop--dev--seed-secret",
                  status: "active",
                },
              ],
            }),
          );
        }
        throw new Error(`Unexpected seed fetch: ${method} ${url}`);
      },
    ) as typeof fetch;

    try {
      await deploy(
        { app: "shop", stage: "dev", entryPoint: storeInfra, files: {} },
        { logger: logger() },
      );
    } finally {
      globalThis.fetch = savedFetch;
    }

    if (!("StoreId" in output)) {
      const db = new DatabaseSync(dbPath);
      try {
        const rows = db
          .prepare(
            "SELECT store_id, state FROM stores WHERE store_id LIKE '%secrets-store'",
          )
          .all() as Array<{ store_id: string; state: string }>;
        for (const row of rows) {
          const parsed = JSON.parse(row.state);
          parsed.output = output;
          db.prepare("UPDATE stores SET state = ? WHERE store_id = ?").run(
            JSON.stringify(parsed),
            row.store_id,
          );
        }
      } finally {
        db.close();
      }
    }
  }

  it("fails on unknown secret ID and lists declared secret IDs", async () => {
    await expect(
      secretSet(deployment(), "nonexistent", { logger: logger() }),
    ).rejects.toThrow(
      'Unknown secret "nonexistent". Declared secrets: admin-password, stripe-key, deploy-token.',
    );

    await expect(
      secretDelete(deployment(), "nonexistent", {
        yes: true,
        logger: logger(),
      }),
    ).rejects.toThrow(
      'Unknown secret "nonexistent". Declared secrets: admin-password, stripe-key, deploy-token.',
    );
  });

  it("reports when no secrets are declared", async () => {
    writeFileSync(path.join(root, "infra.ts"), "export {};\n");
    await expect(
      secretSet(deployment(), "missing", { logger: logger() }),
    ).rejects.toThrow('Unknown secret "missing". No secrets are declared.');
  });

  it("refuses set and delete on a token's secret", async () => {
    await expect(
      secretSet(deployment(), "deploy-token", { logger: logger() }),
    ).rejects.toThrow(/token's secret.*only the token's create/i);

    await expect(
      secretDelete(deployment(), "deploy-token", {
        yes: true,
        logger: logger(),
      }),
    ).rejects.toThrow(/token's secret.*only the token's create/i);
  });

  it("fails when location dependency secrets-store has not been deployed or lacks output", async () => {
    await expect(
      secretSet(deployment(), "admin-password", { logger: logger() }),
    ).rejects.toThrow(
      "admin-password's location depends on secrets-store, which hasn't been deployed. Run notation deploy.",
    );

    // Seed secrets-store without StoreId output
    await seedSecretsStoreState({});
    await expect(
      secretDelete(deployment(), "admin-password", {
        yes: true,
        logger: logger(),
      }),
    ).rejects.toThrow(
      "admin-password's location depends on secrets-store, which hasn't been deployed. Run notation deploy.",
    );
  });

  it("set reads from stdin, creates then updates without touching state or journal", async () => {
    await seedSecretsStoreState({ StoreId: "store-1" });
    const tablesBefore = readSqliteTables(dbPath);

    const store = new Map<string, { id: string; value: string }>();
    const methods: string[] = [];

    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const method = init?.method ?? "GET";
        methods.push(method);

        if (url.includes("/secrets?") && method === "GET") {
          const name = new URL(url).searchParams.get("search")!;
          const existing = store.get(name);
          return new Response(
            JSON.stringify({
              success: true,
              result: existing
                ? [{ id: existing.id, name, status: "active" }]
                : [],
            }),
          );
        }
        if (url.endsWith("/secrets") && method === "POST") {
          const [{ name, value }] = JSON.parse(String(init?.body));
          store.set(name, { id: "sec-1", value });
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ id: "sec-1", name, status: "active" }],
            }),
          );
        }
        if (url.endsWith("/secrets/sec-1") && method === "PATCH") {
          const { value } = JSON.parse(String(init?.body));
          store.set("shop--dev--admin-password", { id: "sec-1", value });
          return new Response(JSON.stringify({ success: true, result: {} }));
        }
        throw new Error(`Unexpected ${method} ${url}`);
      },
    ) as typeof fetch;

    // 1. First set: creates via POST, drops single trailing \r\n
    const stdin1 = new PassThrough();
    stdin1.end("first-value\r\n");
    await secretSet(deployment(), "admin-password", {
      logger: logger(),
      io: { stdin: stdin1, stderr: { isTTY: false, write: vi.fn(() => true) } },
    });
    expect(store.get("shop--dev--admin-password")?.value).toBe("first-value");
    expect(methods).toEqual(["GET", "POST"]);

    // 2. Second set (on TTY): reads hidden prompt, updates via PATCH
    methods.length = 0;
    const tty = makeFakeTty(true);
    const pendingSet = secretSet(deployment(), "admin-password", {
      compile: false,
      logger: logger(),
      io: { stdin: tty.stdin, stderr: tty.stderr },
    });
    await vi.waitFor(() =>
      expect(tty.stderrText()).toContain(
        "Enter value for secret admin-password (stage dev): ",
      ),
    );
    tty.stdin.write("second-value\n");
    await pendingSet;

    expect(store.get("shop--dev--admin-password")?.value).toBe("second-value");
    expect(methods).toEqual(["GET", "PATCH"]);
    expect(tty.stderrText()).not.toContain("second-value");

    // 3. Also works for sourced secret even before SourceValue is in state
    const stdin3 = new PassThrough();
    stdin3.end("manual-stripe-override\n");
    await secretSet(deployment(), "stripe-key", {
      compile: false,
      logger: logger(),
      io: { stdin: stdin3, stderr: { isTTY: false, write: vi.fn(() => true) } },
    });
    expect(store.get("shop--dev--stripe-key")?.value).toBe(
      "manual-stripe-override",
    );

    // Verify neither state nor journal was modified by secretSet
    const tablesAfter = readSqliteTables(dbPath);
    expect(tablesAfter).toEqual(tablesBefore);
  });

  it("delete enforces --yes without TTY, confirms on TTY, and succeeds when already gone", async () => {
    await seedSecretsStoreState({ StoreId: "store-1" });
    let existsInStore = true;
    const deletedUrls: string[] = [];

    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const method = init?.method ?? "GET";
        if (url.includes("/secrets?") && method === "GET") {
          return new Response(
            JSON.stringify({
              success: true,
              result: existsInStore
                ? [
                    {
                      id: "sec-del-1",
                      name: "shop--dev--admin-password",
                      status: "active",
                    },
                  ]
                : [],
            }),
          );
        }
        if (url.endsWith("/secrets/sec-del-1") && method === "DELETE") {
          deletedUrls.push(url);
          existsInStore = false;
          return new Response(JSON.stringify({ success: true, result: {} }));
        }
        throw new Error(`Unexpected ${method} ${url}`);
      },
    ) as typeof fetch;

    // Non-TTY without --yes fails
    const nonTty = makeFakeTty(false);
    await expect(
      secretDelete(deployment(), "admin-password", {
        logger: logger(),
        io: { stdin: nonTty.stdin, stderr: nonTty.stderr },
      }),
    ).rejects.toThrow(
      'Pass --yes to delete secret "admin-password" without a TTY.',
    );

    // TTY without --yes: 'n' aborts
    const ttyNo = makeFakeTty(true);
    const pNo = secretDelete(deployment(), "admin-password", {
      compile: false,
      logger: logger(),
      io: { stdin: ttyNo.stdin, stderr: ttyNo.stderr },
    });
    await vi.waitFor(() =>
      expect(ttyNo.stderrText()).toContain(
        'Delete secret "admin-password" for stage dev? [y/N] ',
      ),
    );
    ttyNo.stdin.write("n\n");
    await pNo;
    expect(deletedUrls).toEqual([]);

    // TTY without --yes: 'y' deletes
    const ttyYes = makeFakeTty(true);
    const pYes = secretDelete(deployment(), "admin-password", {
      compile: false,
      logger: logger(),
      io: { stdin: ttyYes.stdin, stderr: ttyYes.stderr },
    });
    await vi.waitFor(() =>
      expect(ttyYes.stderrText()).toContain(
        'Delete secret "admin-password" for stage dev? [y/N] ',
      ),
    );
    ttyYes.stdin.write("y\n");
    await pYes;
    expect(deletedUrls).toHaveLength(1);

    // Non-TTY with --yes when already gone succeeds cleanly
    await secretDelete(deployment(), "admin-password", {
      compile: false,
      yes: true,
      logger: logger(),
      io: { stdin: nonTty.stdin, stderr: nonTty.stderr },
    });
    expect(deletedUrls).toHaveLength(1);
  });

  it("compiles infra and runtime modules when a Worker binds a secret()", async () => {
    writeFileSync(
      path.join(root, "infra.ts"),
      `
      import { secret } from "@notation/cloudflare";
      import { env } from "@notation/std/sources";
      export const apiKey = secret({ id: "api-key", source: env, key: "API_KEY" });
      `,
    );
    mkdirSync(path.join(root, "runtime"), { recursive: true });
    writeFileSync(
      path.join(root, "runtime/api.ts"),
      `
      import { $worker, secretsStore, type WorkerHandler } from "@notation/cloudflare";
      import { apiKey } from "../infra";

      export const worker = $worker({
        id: "api",
        compatibilityDate: "2026-10-12",
        bindings: () => ({ API_KEY: secretsStore.bind(apiKey) }),
      });

      export default {
        async fetch(_request, env) {
          return new Response(await env.API_KEY.get());
        },
      } satisfies WorkerHandler<typeof worker>;
      `,
    );

    const { modules } = await compileInfra(path.join(root, "infra.ts"));
    await compileRuntimeModules(modules);
    expect(modules.map((m) => path.basename(m.path))).toContain("api.ts");
  });
});
