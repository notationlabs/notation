import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRecordedSecrets, setConfigFile } from "@notation/core";
import { deploy } from "../src/deploy";
import {
  INTERACTIVE_SECRET_PROMPT_ENV,
  promptSecretHidden,
  readSecretFromStdin,
} from "../src/secret-prompt";

const tmpDir = fileURLToPath(new URL("../tmp", import.meta.url));

function makeFakeTty(isRaw = false) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode: (mode: boolean) => void;
    pause: () => PassThrough;
  };
  stdin.isTTY = true;
  stdin.isRaw = isRaw;
  stdin.setRawMode = vi.fn((mode: boolean) => {
    stdin.isRaw = mode;
  });
  const origPause = stdin.pause.bind(stdin);
  stdin.pause = vi.fn(() => origPause());

  const stderrChunks: string[] = [];
  const stderr = {
    isTTY: true,
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

describe("promptSecretHidden", () => {
  it("reads hidden input without echoing characters and restores raw mode", async () => {
    const tty = makeFakeTty(false);
    const pending = promptSecretHidden({
      id: "admin-password",
      stage: "dev",
      stdin: tty.stdin,
      stderr: tty.stderr,
    });

    expect(tty.stdin.setRawMode).toHaveBeenCalledWith(true);
    tty.stdin.write("s3cr");
    tty.stdin.write("\x7f"); // backspace 'r'
    tty.stdin.write("ret!");
    tty.stdin.write("\x1b[A"); // arrow up ignored
    tty.stdin.write("\b"); // backspace '!'
    tty.stdin.write("?\r");

    const redacted = await pending;
    expect(redacted.unwrap()).toBe("s3cret?");
    expect(tty.stderrText()).toBe(
      "Enter value for secret admin-password (stage dev): \n",
    );
    expect(tty.stderrText()).not.toContain("s3ce?");
    expect(tty.stdin.isRaw).toBe(false);
    expect(tty.stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(tty.stdin.pause).toHaveBeenCalled();
  });

  it("restores prior raw mode and rejects on Ctrl-C", async () => {
    const tty = makeFakeTty(true);
    const pending = promptSecretHidden({
      id: "api-key",
      stage: "prod",
      stdin: tty.stdin,
      stderr: tty.stderr,
    });

    tty.stdin.write("partial\u0003");
    await expect(pending).rejects.toThrow("Secret prompt cancelled.");
    expect(tty.stdin.isRaw).toBe(true);
    expect(tty.stdin.pause).toHaveBeenCalled();
  });

  it("handles Ctrl-D empty as cancel and non-empty as submit", async () => {
    const emptyTty = makeFakeTty();
    const p1 = promptSecretHidden({
      id: "k1",
      stage: "dev",
      stdin: emptyTty.stdin,
      stderr: emptyTty.stderr,
    });
    emptyTty.stdin.write("\u0004");
    await expect(p1).rejects.toThrow("Secret prompt cancelled.");

    const valueTty = makeFakeTty();
    const p2 = promptSecretHidden({
      id: "k2",
      stage: "dev",
      stdin: valueTty.stdin,
      stderr: valueTty.stderr,
    });
    valueTty.stdin.write("abc\u0004");
    expect((await p2).unwrap()).toBe("abc");
  });
});

describe("readSecretFromStdin", () => {
  it("drops only one trailing LF or CRLF", async () => {
    const s1 = new PassThrough();
    s1.end("my-secret\n");
    expect(await readSecretFromStdin(s1)).toBe("my-secret");

    const s2 = new PassThrough();
    s2.end("my-secret\r\n");
    expect(await readSecretFromStdin(s2)).toBe("my-secret");

    const s3 = new PassThrough();
    s3.end("line1\nline2\n\n");
    expect(await readSecretFromStdin(s3)).toBe("line1\nline2\n");
  });
});

describe("deploy secret prompt integration", () => {
  let root: string;
  const origAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const origApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const origDbPath = process.env.NOTATION_DATABASE_PATH;
  const origPromptEnv = process.env[INTERACTIVE_SECRET_PROMPT_ENV];
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    root = realpathSync(mkdtempSync(path.join(tmpDir, "notation-prompt-")));
    writeFileSync(path.join(root, "notation.config.ts"), "export default {}");
    writeFileSync(
      path.join(root, "infra.ts"),
      `import { secret } from "@notation/cloudflare";\nexport const adminPassword = secret({ id: "admin-password" });\n`,
    );
    setConfigFile(path.join(root, "notation.config.ts"));
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc-test";
    process.env.CLOUDFLARE_API_TOKEN = "tok-test";
    process.env.NOTATION_DATABASE_PATH = path.join(
      root,
      ".notation/workflows.db",
    );
    delete process.env[INTERACTIVE_SECRET_PROMPT_ENV];
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
    if (origPromptEnv === undefined)
      delete process.env[INTERACTIVE_SECRET_PROMPT_ENV];
    else process.env[INTERACTIVE_SECRET_PROMPT_ENV] = origPromptEnv;
    rmSync(root, { recursive: true, force: true });
  });

  function mockCloudflareSecretsStore() {
    let storedSecret: { id: string; name: string; value: string } | undefined;
    const postBodies: unknown[] = [];

    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const method = init?.method ?? "GET";

        // Stores list
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
        // Store get
        if (url.endsWith("/secrets_store/stores/store-1") && method === "GET") {
          return new Response(
            JSON.stringify({
              success: true,
              result: { id: "store-1", name: "default_secrets_store" },
            }),
          );
        }
        // Secrets search
        if (
          url.includes("/secrets_store/stores/store-1/secrets?") &&
          method === "GET"
        ) {
          return new Response(
            JSON.stringify({
              success: true,
              result: storedSecret
                ? [
                    {
                      id: storedSecret.id,
                      name: storedSecret.name,
                      status: "active",
                    },
                  ]
                : [],
            }),
          );
        }
        // Create secret
        if (
          url.endsWith("/secrets_store/stores/store-1/secrets") &&
          method === "POST"
        ) {
          const body = JSON.parse(String(init?.body)) as Array<{
            name: string;
            value: string;
          }>;
          postBodies.push(body);
          storedSecret = {
            id: "sec-1",
            name: body[0]!.name,
            value: body[0]!.value,
          };
          return new Response(
            JSON.stringify({
              success: true,
              result: [
                {
                  id: storedSecret.id,
                  name: storedSecret.name,
                  status: "active",
                },
              ],
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    ) as typeof fetch;

    return {
      getStored: () => storedSecret,
      postBodies,
    };
  }

  const makeDeployment = () => ({
    app: "demo-app",
    stage: "dev",
    entryPoint: path.join(root, "infra.ts"),
    files: {},
  });

  it("prompts on a TTY during deploy and does not prompt on subsequent deploys", async () => {
    const cf = mockCloudflareSecretsStore();
    const tty = makeFakeTty();
    const logs: string[] = [];
    const logger = {
      info: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      warn: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    };

    const deployPromise = deploy(makeDeployment(), {
      logger,
      io: { stdin: tty.stdin, stderr: tty.stderr },
    });

    await vi.waitFor(() =>
      expect(tty.stderrText()).toContain(
        "Enter value for secret admin-password (stage dev): ",
      ),
    );
    tty.stdin.write("tty-secret-value-1\n");
    await deployPromise;

    expect(cf.getStored()?.value).toBe("tty-secret-value-1");
    expect(tty.stderrText()).not.toContain("tty-secret-value-1");
    expect(logs.join("\n")).not.toContain("tty-secret-value-1");

    // Second deploy (like watch rebuild): already converged, never prompts again.
    const tty2 = makeFakeTty();
    await deploy(makeDeployment(), {
      compile: false,
      logger,
      io: { stdin: tty2.stdin, stderr: tty2.stderr },
    });
    expect(tty2.stderrText()).toBe("");
  });

  it("fails with CLI instructions when no TTY is present", async () => {
    mockCloudflareSecretsStore();
    const nonTtyStdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    nonTtyStdin.isTTY = false;
    const nonTtyStderr = { isTTY: false, write: vi.fn(() => true) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(
      deploy(makeDeployment(), {
        logger,
        io: { stdin: nonTtyStdin, stderr: nonTtyStderr },
      }),
    ).rejects.toThrow(
      "Secret admin-password isn't set for stage dev. Run notation secret set admin-password --stage dev.",
    );
  });

  it("disables prompting with --json even on a TTY unless watch child env is set", async () => {
    mockCloudflareSecretsStore();
    const tty = makeFakeTty();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await expect(
        deploy(makeDeployment(), {
          json: true,
          logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          io: { stdin: tty.stdin, stderr: tty.stderr },
        }),
      ).rejects.toThrow(
        "Secret admin-password isn't set for stage dev. Run notation secret set admin-password --stage dev.",
      );
      expect(tty.stderrText()).toBe("");
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("prompts on stderr in watch child mode (--json + NOTATION_SECRET_PROMPT=1) without corrupting NDJSON stdout", async () => {
    const cf = mockCloudflareSecretsStore();
    const tty = makeFakeTty();
    process.env[INTERACTIVE_SECRET_PROMPT_ENV] = "1";

    const stdoutLines: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdoutLines.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8"),
        );
        return true;
      });

    try {
      const deployPromise = deploy(makeDeployment(), {
        json: true,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        io: { stdin: tty.stdin, stderr: tty.stderr },
      });

      await vi.waitFor(() =>
        expect(tty.stderrText()).toContain(
          "Enter value for secret admin-password (stage dev): ",
        ),
      );
      tty.stdin.write("watch-secret-123\n");
      await deployPromise;

      expect(cf.getStored()?.value).toBe("watch-secret-123");
      const ndjson = stdoutLines
        .join("")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(ndjson.length).toBeGreaterThan(0);
      expect(stdoutLines.join("")).not.toContain("Enter value for secret");
      expect(stdoutLines.join("")).not.toContain("watch-secret-123");
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
