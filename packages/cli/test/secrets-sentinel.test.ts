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
  NodeDurableRuntime,
  clearRecordedSecrets,
  recordSecret,
  setConfigFile,
  type Deployment,
} from "@notation/core";
import { compile } from "../src/compile";
import { deploy } from "../src/deploy";
import { destroy } from "../src/destroy";
import { createScrubbedLogger, defaultLogger } from "../src/logger";
import { plan } from "../src/plan";
import { runWithErrorHandling } from "../src/run-with-error-handling";
import { secretSet } from "../src/secret";

const tmpDir = fileURLToPath(new URL("../tmp", import.meta.url));

function secretVariants(raw: string): {
  raw: string;
  base64: string;
  jsonEscaped: string;
} {
  return {
    raw,
    base64: Buffer.from(raw, "utf8").toString("base64"),
    jsonEscaped: JSON.stringify(raw).slice(1, -1),
  };
}

function assertContainsNoSecret(
  surfaceName: string,
  text: string,
  secrets: string[],
): void {
  for (const raw of secrets) {
    const { base64, jsonEscaped } = secretVariants(raw);
    expect(text, `${surfaceName} leaked raw secret`).not.toContain(raw);
    expect(text, `${surfaceName} leaked base64 secret`).not.toContain(base64);
    expect(text, `${surfaceName} leaked JSON-escaped secret`).not.toContain(
      jsonEscaped,
    );
  }
}

function dumpAllSqliteRows(dbPath: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const chunks: string[] = [];
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Array<
        Record<string, unknown>
      >;
      for (const row of rows) {
        chunks.push(
          `${name}: ` +
            Object.entries(row)
              .map(([k, v]) => {
                if (v instanceof Uint8Array) {
                  return `${k}=${Buffer.from(v).toString("utf8")}`;
                }
                return `${k}=${String(v)}`;
              })
              .join(" "),
        );
      }
    }
    return chunks.join("\n");
  } finally {
    db.close();
  }
}

function captureStdStreams() {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stdoutChunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }) as typeof process.stdout.write);

  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderrChunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }) as typeof process.stderr.write);

  return {
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    },
  };
}

describe("secrets sentinel and CLI scrubbing", () => {
  let root: string;
  let dbPath: string;
  const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const origApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const origDbPath = process.env.NOTATION_DATABASE_PATH;
  const origEnvSentinel = process.env.SENTINEL_ENV_SECRET;
  const origFetch = globalThis.fetch;

  const ENV_SENTINEL = 'sentinel_"env"\\value_1\nend!';
  const DOTENV_SENTINEL = 'sentinel_"dotenv"\\value_2\nend!';

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    root = realpathSync(mkdtempSync(path.join(tmpDir, "notation-sentinel-")));
    dbPath = path.join(root, ".notation/workflows.db");
    writeFileSync(path.join(root, "notation.config.ts"), "export default {}");
    writeFileSync(
      path.join(root, ".env.local"),
      `DOTENV_KEY='${DOTENV_SENTINEL}'\n`,
    );
    writeFileSync(
      path.join(root, "infra.ts"),
      `
      import { secret } from "@notation/cloudflare";
      import { dotenv, env } from "@notation/std/sources";

      export const envSecret = secret({
        id: "env-secret",
        source: env,
        key: "SENTINEL_ENV_SECRET",
      });

      export const dotenvSecret = secret({
        id: "dotenv-secret",
        source: dotenv(".env.local"),
        key: "DOTENV_KEY",
      });
      `,
    );
    setConfigFile(path.join(root, "notation.config.ts"));
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc-sentinel";
    process.env.CLOUDFLARE_API_TOKEN = "tok-sentinel";
    process.env.NOTATION_DATABASE_PATH = dbPath;
    process.env.SENTINEL_ENV_SECRET = ENV_SENTINEL;
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
    if (origEnvSentinel === undefined) delete process.env.SENTINEL_ENV_SECRET;
    else process.env.SENTINEL_ENV_SECRET = origEnvSentinel;
    rmSync(root, { recursive: true, force: true });
  });

  const deployment = (): Deployment => ({
    app: "sentinel-app",
    stage: "prod",
    entryPoint: path.join(root, "infra.ts"),
    files: {},
  });

  it("never leaks sentinel values (raw, base64, JSON-escaped) across compile, plan --json, deploy --json, state, journal, stdout, or stderr", async () => {
    const writtenValues = new Map<string, string>();
    let nextId = 1;

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
              result: [{ id: "store-s1", name: "default_secrets_store" }],
            }),
          );
        }
        if (
          url.endsWith("/secrets_store/stores/store-s1") &&
          method === "GET"
        ) {
          return new Response(
            JSON.stringify({
              success: true,
              result: { id: "store-s1", name: "default_secrets_store" },
            }),
          );
        }
        if (
          url.includes("/secrets_store/stores/store-s1/secrets?") &&
          method === "GET"
        ) {
          const search = new URL(url).searchParams.get("search")!;
          const exists = writtenValues.has(search);
          return new Response(
            JSON.stringify({
              success: true,
              result: exists
                ? [{ id: `sec-${search}`, name: search, status: "active" }]
                : [],
            }),
          );
        }
        if (
          url.endsWith("/secrets_store/stores/store-s1/secrets") &&
          method === "POST"
        ) {
          const [{ name, value }] = JSON.parse(String(init?.body)) as Array<{
            name: string;
            value: string;
          }>;
          writtenValues.set(name, value);
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ id: `sec-${nextId++}`, name, status: "active" }],
            }),
          );
        }
        throw new Error(`Unexpected ${method} ${url}`);
      },
    ) as typeof fetch;

    const logs: string[] = [];
    const logger = createScrubbedLogger({
      info: (...args: unknown[]) =>
        logs.push(args.map((a) => JSON.stringify(a) ?? String(a)).join(" ")),
      warn: (...args: unknown[]) =>
        logs.push(args.map((a) => JSON.stringify(a) ?? String(a)).join(" ")),
      error: (...args: unknown[]) =>
        logs.push(args.map((a) => JSON.stringify(a) ?? String(a)).join(" ")),
    });

    const streams = captureStdStreams();
    try {
      await compile(deployment(), { logger });
      await plan(deployment(), { json: true, logger });
      const planJsonText = streams.stdout();

      await deploy(deployment(), { json: true, compile: false, logger });
      const allStdout = streams.stdout();
      const deployNdjsonText = allStdout.slice(planJsonText.length);
      const allStderr = streams.stderr();

      // Confirm Cloudflare actually received the real sentinel values
      expect(writtenValues.get("sentinel-app--prod--env-secret")).toBe(
        ENV_SENTINEL,
      );
      expect(writtenValues.get("sentinel-app--prod--dotenv-secret")).toBe(
        DOTENV_SENTINEL,
      );

      // Verify state
      const runtime = new NodeDurableRuntime({
        deployment: deployment(),
        databasePath: dbPath,
      });
      let stateText: string;
      try {
        const nodes = await runtime.state.values();
        expect(nodes.length).toBeGreaterThanOrEqual(5);
        stateText = JSON.stringify(nodes);
      } finally {
        runtime.close();
      }

      // Verify durable SQLite journal (all tables & rows)
      const journalText = dumpAllSqliteRows(dbPath);

      const sentinels = [ENV_SENTINEL, DOTENV_SENTINEL];
      assertContainsNoSecret("runtime.state", stateText, sentinels);
      assertContainsNoSecret("workflows.db", journalText, sentinels);
      assertContainsNoSecret("plan --json", planJsonText, sentinels);
      assertContainsNoSecret(
        "deploy --json NDJSON",
        deployNdjsonText,
        sentinels,
      );
      assertContainsNoSecret("CLI stdout", allStdout, sentinels);
      assertContainsNoSecret("CLI stderr", allStderr, sentinels);
      assertContainsNoSecret("CLI logger", logs.join("\n"), sentinels);
    } finally {
      streams.restore();
    }
  });

  it("scrubs echoed raw, base64, and JSON-escaped sentinels when Cloudflare API errors during deploy --json", async () => {
    const { raw, base64, jsonEscaped } = secretVariants(ENV_SENTINEL);
    const echoedErrorText = `Invalid secret value: raw=${raw} b64=${base64} json=${jsonEscaped}`;

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
              result: [{ id: "store-err", name: "default_secrets_store" }],
            }),
          );
        }
        if (
          url.endsWith("/secrets_store/stores/store-err") &&
          method === "GET"
        ) {
          return new Response(
            JSON.stringify({
              success: true,
              result: { id: "store-err", name: "default_secrets_store" },
            }),
          );
        }
        if (
          url.includes("/secrets_store/stores/store-err/secrets?") &&
          method === "GET"
        ) {
          return new Response(JSON.stringify({ success: true, result: [] }));
        }
        if (
          url.endsWith("/secrets_store/stores/store-err/secrets") &&
          method === "POST"
        ) {
          return new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 1000, message: echoedErrorText }],
            }),
            { status: 400 },
          );
        }
        throw new Error(`Unexpected ${method} ${url}`);
      },
    ) as typeof fetch;

    const logErrors: string[] = [];
    const logger = createScrubbedLogger({
      info: vi.fn(),
      warn: vi.fn(),
      error: (...args: unknown[]) => {
        for (const arg of args) {
          logErrors.push(
            arg instanceof Error
              ? `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`
              : String(arg),
          );
        }
      },
    });

    const streams = captureStdStreams();
    try {
      const exitCode = await runWithErrorHandling(
        () => deploy(deployment(), { json: true, logger }),
        { logger, command: "deploy" },
      );

      expect(exitCode).toBe(1);
      const stdout = streams.stdout();
      const stderr = streams.stderr();
      const journalText = dumpAllSqliteRows(dbPath);

      const runtime = new NodeDurableRuntime({
        deployment: deployment(),
        databasePath: dbPath,
      });
      let stateText: string;
      try {
        stateText = JSON.stringify(await runtime.state.values());
      } finally {
        runtime.close();
      }

      const sentinels = [ENV_SENTINEL, DOTENV_SENTINEL];
      assertContainsNoSecret("runtime.state", stateText, sentinels);
      assertContainsNoSecret("workflows.db", journalText, sentinels);
      assertContainsNoSecret("deploy --json stdout/NDJSON", stdout, sentinels);
      assertContainsNoSecret("CLI stderr", stderr, sentinels);
      assertContainsNoSecret(
        "runWithErrorHandling logger",
        logErrors.join("\n"),
        sentinels,
      );

      // Confirm redaction markers are present in both the NDJSON error event and logged error
      expect(stdout).toContain("[REDACTED]");
      expect(logErrors.join("\n")).toContain("[REDACTED]");
    } finally {
      streams.restore();
    }
  });

  it("scrubs secrets across runWithErrorHandling, logger, console, destroy --json, and secretSet errors", async () => {
    const secret = 'scrub_"me"\\now\n!';
    const { base64, jsonEscaped } = secretVariants(secret);
    recordSecret(secret);

    // 1. runWithErrorHandling + logger
    const errorLines: string[] = [];
    const logger = createScrubbedLogger({
      info: vi.fn(),
      warn: vi.fn(),
      error: (err: unknown) =>
        errorLines.push(
          err instanceof Error
            ? `${err.message}\n${err.stack ?? ""}`
            : String(err),
        ),
    });
    const code = await runWithErrorHandling(
      async () => {
        throw new Error(
          `boom raw=${secret} b64=${base64} json=${jsonEscaped}`,
          {
            cause: new Error(`cause=${secret}`),
          },
        );
      },
      { logger, command: "deploy" },
    );
    expect(code).toBe(1);
    assertContainsNoSecret("runWithErrorHandling", errorLines.join("\n"), [
      secret,
    ]);
    expect(errorLines.join("\n")).toContain("[REDACTED]");

    // 2. defaultLogger scrubs console output without mutating global console
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      defaultLogger.error(`err=${jsonEscaped} raw=${secret}`);
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
      assertContainsNoSecret(
        "defaultLogger",
        String(consoleErrorSpy.mock.calls[0]?.[0]),
        [secret],
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }

    // 3. secretSet error scrubbing when Cloudflare echoes the value read from stdin
    // First deploy the store cleanly via mocked Cloudflare API
    const deployedSecrets = new Map<string, string>();
    let deployedNextId = 1;
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
              result: [{ id: "store-s1", name: "default_secrets_store" }],
            }),
          );
        }
        if (
          url.endsWith("/secrets_store/stores/store-s1") &&
          method === "GET"
        ) {
          return new Response(
            JSON.stringify({
              success: true,
              result: { id: "store-s1", name: "default_secrets_store" },
            }),
          );
        }
        if (url.includes("/secrets?") && method === "GET") {
          const name = new URL(url).searchParams.get("search");
          const existingId = name ? deployedSecrets.get(name) : undefined;
          return new Response(
            JSON.stringify({
              success: true,
              result: existingId
                ? [{ id: existingId, name, status: "active" }]
                : [],
            }),
          );
        }
        if (url.endsWith("/secrets") && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as Array<{
            name: string;
          }>;
          const items = body.map((item) => {
            const secId = `sec-ok-${deployedNextId++}`;
            deployedSecrets.set(item.name, secId);
            return { id: secId, name: item.name, status: "active" };
          });
          return new Response(JSON.stringify({ success: true, result: items }));
        }
        throw new Error(`Unexpected ${method} ${url}`);
      },
    ) as typeof fetch;
    await deploy(deployment(), { logger });

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
          url.endsWith("/secrets_store/stores/store-s1") &&
          method === "GET"
        ) {
          return new Response(
            JSON.stringify({
              success: true,
              result: { id: "store-s1", name: "default_secrets_store" },
            }),
          );
        }
        if (url.includes("/secrets?") && method === "GET") {
          return new Response(JSON.stringify({ success: true, result: [] }));
        }
        if (url.includes("/secrets/sec-ok") && method === "GET") {
          return new Response(
            JSON.stringify({
              success: true,
              result: { id: "sec-ok", name: "ok", status: "active" },
            }),
          );
        }
        if (url.endsWith("/secrets") && method === "POST") {
          return new Response(
            JSON.stringify({
              success: false,
              errors: [
                {
                  code: 1000,
                  message: `bad: ${secret} ${base64} ${jsonEscaped}`,
                },
              ],
            }),
            { status: 400 },
          );
        }
        if (method === "DELETE") {
          return new Response(JSON.stringify({ success: true, result: {} }));
        }
        throw new Error(`Unexpected ${method} ${url}`);
      },
    ) as typeof fetch;

    const stdin = new PassThrough();
    stdin.end(`${secret}\n`);
    let caught: unknown;
    try {
      await secretSet(deployment(), "env-secret", {
        logger,
        io: { stdin, stderr: { isTTY: false, write: vi.fn(() => true) } },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    assertContainsNoSecret("secretSet error", (caught as Error).message, [
      secret,
    ]);
    expect((caught as Error).message).toContain("[REDACTED]");

    // 4. destroy --json scrubbing
    const streams2 = captureStdStreams();
    try {
      await destroy(deployment(), { json: true, logger });
      assertContainsNoSecret("destroy --json stdout", streams2.stdout(), [
        secret,
      ]);
      assertContainsNoSecret("destroy --json stderr", streams2.stderr(), [
        secret,
      ]);
    } finally {
      streams2.restore();
    }
  });
});
