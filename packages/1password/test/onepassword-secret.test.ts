import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { NodeDurableRuntime, runDurableWorkflow } from "@notation/core";
import { createPlan } from "@notation/reconciler";
import * as durable from "@notation/reconciler/durable";
import {
  isResourceClass,
  resource,
  type BaseCredentialSource,
  type BaseResource,
} from "@notation/resource";
import { clearSecretValues, scrubSecretValues } from "@notation/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as onepassword from "src/resources";
import {
  ItemReplacedError,
  OnePasswordError,
  OnePasswordSecret,
} from "src/resources";
import { opItemGet } from "src/op";

type Call = {
  args: string[];
  started: number;
  ended: number;
  stdinIsPipe: boolean;
};

type Answer = { delayMs?: number } & (
  | { item: unknown }
  | { stdout: string }
  | { stderr: string; stdout?: string; exitCode?: number }
);

type FieldInput = {
  id?: string;
  label: string;
  type?: string;
  value?: string;
  section?: { id: string; label?: string };
};

const SENTINEL = "sentinel-value-0b7f3e";

let directory: string;
let logDirectory: string;
let fixturePath: string;
let runtime: NodeDurableRuntime | undefined;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "notation-1password-"));
  const bin = path.join(directory, "bin");
  logDirectory = path.join(directory, "log");
  fixturePath = path.join(directory, "fixture.json");
  await mkdir(bin);
  await mkdir(logDirectory);
  await copyFile(
    path.join(import.meta.dirname, "fake-op.cjs"),
    path.join(bin, "op"),
  );
  await chmod(path.join(bin, "op"), 0o755);
  await setItems({});
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv("FAKE_OP_FIXTURE", fixturePath);
  vi.stubEnv("FAKE_OP_LOG", logDirectory);
  for (const name of [
    "OP_ACCOUNT",
    "OP_SERVICE_ACCOUNT_TOKEN",
    "OP_CONNECT_HOST",
    "OP_CONNECT_TOKEN",
    "NOTATION_TRACK_KEY",
  ]) {
    vi.stubEnv(name, undefined);
  }
  clearSecretValues();
});

afterEach(async () => {
  runtime?.close();
  runtime = undefined;
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

/**
 * Writes the fixture of the fake `op` in `fake-op.cjs`. It answers
 * `op item get <item> --vault=<vault>` with `items["<vault>/<item>"]`, or
 * with `all` when it is set, and says that any other item isn't there. It
 * writes a record of each call to a file of its own in the log folder.
 */
function setItems(items: Record<string, Answer>, all?: Answer) {
  return writeFile(fixturePath, JSON.stringify({ items, all }));
}

async function calls(): Promise<Call[]> {
  const files = await readdir(logDirectory);
  const read = await Promise.all(
    files.map(
      async (file) =>
        JSON.parse(
          await readFile(path.join(logDirectory, file), "utf8"),
        ) as Call,
    ),
  );
  return read.sort((a, b) => a.started - b.started);
}

/** An item in the vault `Prod`, as `op item get --format json` prints it. */
function item(
  title: string,
  options: { id?: string; version?: number; state?: string },
  fields: FieldInput[],
) {
  return {
    id: options.id ?? `${title.toLowerCase()}-id`,
    title,
    version: options.version ?? 1,
    ...(options.state ? { state: options.state } : {}),
    vault: { id: "prod-vault-id", name: "Prod" },
    updated_at: "2026-11-19T12:00:00Z",
    fields: fields.map((field) => ({
      id: field.id ?? field.label,
      type: field.type ?? "STRING",
      label: field.label,
      ...(field.section ? { section: field.section } : {}),
      ...(field.value !== undefined ? { value: field.value } : {}),
      reference: `op://Prod/${title}/${field.section ? `${field.section.label ?? field.section.id}/` : ""}${field.label}`,
    })),
  };
}

const scope = { app: "shop", stage: "prod" };

function source(id: string, reference: string, track?: "hmac") {
  return new OnePasswordSecret(id, {
    config: { reference, ...(track ? { track } : {}) },
  }) as unknown as BaseCredentialSource;
}

async function prefetch(
  sources: { id: string; reference: string }[],
  notify: (message: string) => void = () => {},
) {
  const declared = sources.map(({ id, reference }) => source(id, reference));
  return declared[0]!.prefetch!(
    sources.map(({ id, reference }) => ({ id, params: { reference } })),
    { ...scope, executionId: "exec-1", notify },
  );
}

async function read(
  declared: BaseCredentialSource,
  params: Record<string, unknown>,
  prefetched?: unknown,
): Promise<string> {
  const result = (await declared.readSource(params, {
    ...scope,
    id: declared.id,
    executionId: "exec-1",
    state: undefined,
    warn: () => {},
    prefetched,
  })) as { revision: string };
  return result.revision;
}

function load(
  declared: BaseCredentialSource,
  state: Record<string, unknown>,
  prefetched?: unknown,
) {
  return declared.loadCredential(state, {
    ...scope,
    id: declared.id,
    executionId: "exec-1",
    prefetched,
  });
}

/** A resource that takes a value, and logs each write and the number of `op` calls before it. */
function defineConsumer(log: string[]) {
  return resource<{
    Key: { name: string };
    CreateParams: { name: string; Value: string };
    UpdateParams: { Value: string };
    ReadResult: {};
  }>({ type: "test/1password/Consumer", provider: "test" })
    .defineSchema({
      name: {
        propertyType: "param",
        presence: "required",
        immutable: true,
        primaryKey: true,
        value: v.string(),
      },
      Value: {
        propertyType: "param",
        presence: "required",
        sensitive: true,
        value: v.string(),
      },
    } as const)
    .defineOperations({
      create: async (params) => {
        log.push(
          `create ${params.name}=${params.Value} after ${(await calls()).length} calls`,
        );
      },
      update: async (key, patch) => {
        log.push(
          `update ${key.name}=${patch.Value} after ${(await calls()).length} calls`,
        );
      },
      delete: async () => {},
    });
}

function declareApp(log: string[]): BaseResource[] {
  const Consumer = defineConsumer(log);
  const sources = [
    new OnePasswordSecret("stripe-key", {
      config: { reference: "op://Prod/Stripe/api key" },
    }),
    new OnePasswordSecret("stripe-webhook", {
      config: { reference: "op://Prod/Stripe/webhook secret" },
    }),
    new OnePasswordSecret("database-url", {
      config: { reference: "op://Prod/Orders database/url" },
    }),
  ];
  return [
    ...sources,
    ...sources.map(
      (secret) =>
        new Consumer(`consumer:${secret.id}`, {
          config: { name: secret.id, Value: secret.credentials.value },
        }),
    ),
  ];
}

function appItems(stripeVersion = 1, stripeKey = "sk_live_1") {
  return {
    "Prod/Stripe": {
      item: item("Stripe", { version: stripeVersion }, [
        { label: "api key", type: "CONCEALED", value: stripeKey },
        { label: "webhook secret", type: "CONCEALED", value: "whsec_12345678" },
      ]),
      delayMs: 100,
    },
    "Prod/Orders database": {
      item: item("Orders database", {}, [
        { label: "url", value: "postgres://db/orders" },
      ]),
    },
  };
}

function deploy(resources: BaseResource[], executionId: string) {
  runtime ??= new NodeDurableRuntime({
    deployment: { app: "shop", stage: "prod" },
    databasePath: path.join(directory, "workflows.db"),
  });
  return runDurableWorkflow(
    { workflowId: "deploy", runtime, executionId },
    (step, executionId) =>
      durable.deploy(step, {
        executionId,
        resources,
        state: runtime!.state,
        driftDetection: false,
        ...scope,
      }),
  );
}

describe("OnePasswordSecret", () => {
  it("is exported with @notation/1password/resources as its provider", () => {
    const classes = (Object.values(onepassword) as unknown[]).filter(
      isResourceClass,
    );
    expect(classes).toEqual([OnePasswordSecret]);
    expect(OnePasswordSecret.provider).toBe("@notation/1password/resources");
  });

  describe("in a deploy", () => {
    it("fetches three sources in two items with one call and then one more, before any resource changes, and calls op no more", async () => {
      await setItems(appItems());
      const log: string[] = [];

      await deploy(declareApp(log), "first");

      const made = await calls();
      expect(made.map((call) => call.args)).toEqual([
        ["item", "get", "Stripe", "--vault=Prod", "--format", "json"],
        ["item", "get", "Orders database", "--vault=Prod", "--format", "json"],
      ]);
      expect(made[1]!.started).toBeGreaterThanOrEqual(made[0]!.ended);
      expect(made.every((call) => !call.stdinIsPipe)).toBe(true);
      expect(log.sort()).toEqual([
        "create database-url=postgres://db/orders after 2 calls",
        "create stripe-key=sk_live_1 after 2 calls",
        "create stripe-webhook=whsec_12345678 after 2 calls",
      ]);
    });

    it("fetches in plan too", async () => {
      await setItems(appItems());
      runtime = new NodeDurableRuntime({
        deployment: { app: "shop", stage: "prod" },
        databasePath: path.join(directory, "workflows.db"),
      });

      await createPlan({
        resources: declareApp([]),
        state: runtime.state,
        ...scope,
      });

      expect(await calls()).toHaveLength(2);
    });

    it("fetches again in a second deploy of the process, and reads its own items", async () => {
      await setItems(appItems());
      const log: string[] = [];
      await deploy(declareApp(log), "first");
      await setItems(appItems(2, "sk_live_2"));
      log.length = 0;

      await deploy(declareApp(log), "second");

      expect(await calls()).toHaveLength(4);
      expect(log.sort()).toEqual([
        "update stripe-key=sk_live_2 after 4 calls",
        "update stripe-webhook=whsec_12345678 after 4 calls",
      ]);
    });

    it("stops after a first call that fails with authorization timeout, and changes nothing", async () => {
      await setItems(
        {},
        {
          stderr:
            "[ERROR] 2026/11/19 12:00:00 authorization prompt dismissed, please try again: authorization timeout",
        },
      );
      const log: string[] = [];

      await expect(deploy(declareApp(log), "first")).rejects.toThrow(
        "needs a 1Password service account in OP_SERVICE_ACCOUNT_TOKEN",
      );

      expect(await calls()).toHaveLength(1);
      expect(log).toEqual([]);
      expect(await runtime!.state.values()).toEqual([]);
    });
  });

  describe("prefetch", () => {
    it("fetches ten items with one call and then nine, at most eight at a time", async () => {
      const items: Record<string, Answer> = {};
      const sources = [];
      for (let index = 0; index < 10; index++) {
        items[`Prod/Item ${index}`] = {
          item: item(`Item ${index}`, {}, [
            { label: "value", value: `v${index}` },
          ]),
          delayMs: 400,
        };
        sources.push({
          id: `s${index}`,
          reference: `op://Prod/Item ${index}/value`,
        });
      }
      await setItems(items);

      const result = await prefetch(sources);

      expect(result.failed).toEqual([]);
      const made = await calls();
      expect(made).toHaveLength(10);
      expect(made.every((call) => call.args.includes("--vault=Prod"))).toBe(
        true,
      );
      const [first, ...rest] = made;
      expect(rest.every((call) => call.started >= first!.ended)).toBe(true);
      const running = (at: number) =>
        made.filter((call) => call.started <= at && call.ended > at).length;
      const most = Math.max(...made.map((call) => running(call.started)));
      expect(most).toBeLessThanOrEqual(8);
      expect(most).toBeGreaterThan(1);
    });

    it("puts only the sources of an item that isn't there in failed, with op's message, and fetches the others", async () => {
      await setItems(appItems());
      const sources = [
        { id: "stripe-key", reference: "op://Prod/Stripe/api key" },
        { id: "missing-a", reference: "op://Prod/Missing/a" },
        { id: "missing-b", reference: "op://Prod/Missing/b" },
        { id: "database-url", reference: "op://Prod/Orders database/url" },
      ];

      for (const order of [
        sources,
        [sources[1]!, sources[0]!, sources[2]!, sources[3]!],
      ]) {
        clearSecretValues();
        const result = await prefetch(order);

        expect(result.failed.map((failure) => failure.id).sort()).toEqual([
          "missing-a",
          "missing-b",
        ]);
        expect(result.failed[0]!.error).toBeInstanceOf(OnePasswordError);
        expect(
          result.failed.find((f) => f.id === "missing-a")!.error.message,
        ).toBe(
          'Can\'t fetch `op://Prod/Missing/a`. op failed with exit code 1: "Missing" isn\'t an item in the "Prod" vault. Specify the item with its UUID, name, or domain. op looked in the account that you signed in to last. Set OP_ACCOUNT to choose another.',
        );
        const items = result.prefetched as Map<string, unknown>;
        expect([...items.keys()].sort()).toEqual([
          "op://Prod/Orders database/url",
          "op://Prod/Stripe/api key",
        ]);
      }
    });

    it("puts the sources of a vault that isn't there in failed, and fetches the others", async () => {
      await setItems({
        ...appItems(),
        "Nope/Stripe": {
          stderr:
            '[ERROR] 2026/11/19 12:00:00 "Nope" isn\'t a vault in this account. Specify the vault with its ID or name.',
        },
      });

      const result = await prefetch([
        { id: "missing", reference: "op://Nope/Stripe/api key" },
        { id: "database-url", reference: "op://Prod/Orders database/url" },
      ]);

      expect(result.failed.map((failure) => failure.id)).toEqual(["missing"]);
      expect(result.failed[0]!.error.message).toBe(
        "Can't fetch `op://Nope/Stripe/api key`. op failed with exit code 1: \"Nope\" isn't a vault in this account. Specify the vault with its ID or name. op looked in the account that you signed in to last. Set OP_ACCOUNT to choose another.",
      );
      expect([...(result.prefetched as Map<string, unknown>).keys()]).toEqual([
        "op://Prod/Orders database/url",
      ]);
    });

    it("says to use the item's ID when more than one item matches, and does not name the account", async () => {
      await setItems({
        ...appItems(),
        "Prod/Twin": {
          stderr:
            '[ERROR] 2026/11/19 12:00:00 More than one item matches "Twin". Try again and specify the item by its ID.',
        },
      });

      const result = await prefetch([
        { id: "twin", reference: "op://Prod/Twin/x" },
        { id: "database-url", reference: "op://Prod/Orders database/url" },
      ]);

      expect(result.failed.map((failure) => failure.id)).toEqual(["twin"]);
      expect(result.failed[0]!.error.message).toBe(
        "Can't fetch `op://Prod/Twin/x`. op failed with exit code 1: More than one item matches \"Twin\". Try again and specify the item by its ID. Use the item's ID in the reference instead of its name.",
      );
    });

    it("names OP_ACCOUNT when it is set", async () => {
      vi.stubEnv("OP_ACCOUNT", "work.1password.com");

      const result = await prefetch([
        { id: "missing", reference: "op://Prod/Missing/a" },
      ]);

      expect(result.failed[0]!.error.message).toContain(
        "op looked in the account in OP_ACCOUNT, `work.1password.com`.",
      );
    });

    it("throws for a message that it does not know", async () => {
      await setItems(
        {},
        {
          stderr:
            "[ERROR] 2026/11/19 12:00:00 error initializing client: bad token",
        },
      );

      const error = await prefetch([
        { id: "a", reference: "op://Prod/A/x" },
        { id: "b", reference: "op://Prod/B/x" },
      ]).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(OnePasswordError);
      expect((error as OnePasswordError).exitCode).toBe(1);
      expect((error as Error).message).toBe(
        "op failed with exit code 1: error initializing client: bad token",
      );
      expect(await calls()).toHaveLength(1);
    });

    it("shows a message once when the first call takes longer than 2 seconds", async () => {
      await setItems({
        "Prod/Slow": {
          item: item("Slow", {}, [{ label: "x", value: "slow value" }]),
          delayMs: 2300,
        },
        "Prod/Other": {
          item: item("Other", {}, [{ label: "x", value: "other" }]),
        },
      });
      const notify = vi.fn();

      await prefetch(
        [
          { id: "slow", reference: "op://Prod/Slow/x" },
          { id: "other", reference: "op://Prod/Other/x" },
        ],
        notify,
      );

      expect(notify.mock.calls).toEqual([
        ["Waiting for 1Password. Approve the request in the 1Password app."],
      ]);
    }, 10_000);

    it.each(["OP_SERVICE_ACCOUNT_TOKEN", "OP_CONNECT_HOST"])(
      "does not show the message for a slow first call with %s set",
      async (name) => {
        vi.stubEnv(name, "set");
        await setItems({
          "Prod/Slow": {
            item: item("Slow", {}, [{ label: "x", value: "slow value" }]),
            delayMs: 2300,
          },
        });
        const notify = vi.fn();

        await prefetch([{ id: "slow", reference: "op://Prod/Slow/x" }], notify);

        expect(notify).not.toHaveBeenCalled();
      },
      10_000,
    );

    it("does not show the message for a fast first call", async () => {
      await setItems(appItems());
      const notify = vi.fn();

      await prefetch(
        [{ id: "a", reference: "op://Prod/Stripe/api key" }],
        notify,
      );

      expect(notify).not.toHaveBeenCalled();
    });

    it("fails a source in an archived item", async () => {
      await setItems({
        "Prod/Old": {
          item: item("Old", { state: "ARCHIVED" }, [
            { label: "x", value: "old value" },
          ]),
        },
      });

      const result = await prefetch([
        { id: "old", reference: "op://Prod/Old/x" },
      ]);

      expect(result.failed[0]!.error.message).toBe(
        "The item of `op://Prod/Old/x` is archived in 1Password. Restore it, or change the reference.",
      );
      await expect(
        read(source("old", "op://Prod/Old/x"), {
          reference: "op://Prod/Old/x",
        }),
      ).rejects.toThrow("is archived");
    });

    it("fails with an install message when op is missing", async () => {
      vi.stubEnv("PATH", path.join(directory, "log"));

      await expect(
        prefetch([{ id: "a", reference: "op://Prod/A/x" }]),
      ).rejects.toThrow(
        "The 1Password CLI, op, is required, and it isn't on PATH. Install it: https://developer.1password.com/docs/cli/get-started/",
      );
    });
  });

  describe("read and loadCredential", () => {
    const reference = "op://Prod/Stripe/api key";

    it("make no op call after prefetch", async () => {
      await setItems(appItems());
      const { prefetched } = await prefetch([{ id: "stripe-key", reference }]);
      const declared = source("stripe-key", reference);

      const revision = await read(declared, { reference }, prefetched);
      await expect(
        load(declared, { reference, revision }, prefetched),
      ).resolves.toBe("sk_live_1");

      expect(revision).toBe("version:stripe-id:1");
      expect(await calls()).toHaveLength(1);
    });

    it("fetch a source that prefetch was not given, in read and again in loadCredential", async () => {
      await setItems(appItems());
      const declared = source("stripe-key", reference);
      const prefetched = new Map();

      const revision = await read(declared, { reference }, prefetched);
      expect(await calls()).toHaveLength(1);
      await expect(
        load(declared, { reference, revision }, prefetched),
      ).resolves.toBe("sk_live_1");
      expect(await calls()).toHaveLength(2);
    });

    it("fetch a source that prefetch was not given, when prefetch fetched another field of its item", async () => {
      await setItems(appItems());
      const { prefetched } = await prefetch([{ id: "stripe-key", reference }]);
      const webhook = "op://Prod/Stripe/webhook secret";
      const declared = source("stripe-webhook", webhook);

      const revision = await read(declared, { reference: webhook }, prefetched);
      await expect(
        load(declared, { reference: webhook, revision }, prefetched),
      ).resolves.toBe("whsec_12345678");

      expect(revision).toBe("version:stripe-id:1");
      expect(await calls()).toHaveLength(3);
    });

    it("with track, keep the revision when another field of the item changes", async () => {
      vi.stubEnv("NOTATION_TRACK_KEY", "track-key");
      await setItems(appItems());
      const declared = source("stripe-key", reference, "hmac");
      const params = { reference, track: "hmac" };

      const revision = await read(declared, params);
      expect(revision).toMatch(/^hmac:[0-9a-f]{64}$/);

      await setItems({
        "Prod/Stripe": {
          item: item("Stripe", { version: 7 }, [
            { label: "api key", type: "CONCEALED", value: "sk_live_1" },
            {
              label: "webhook secret",
              type: "CONCEALED",
              value: "whsec_changed",
            },
          ]),
        },
      });
      expect(await read(declared, params)).toBe(revision);
      await expect(load(declared, { ...params, revision })).resolves.toBe(
        "sk_live_1",
      );

      await setItems(appItems(8, "sk_live_8"));
      await expect(load(declared, { ...params, revision })).rejects.toThrow(
        "`op://Prod/Stripe/api key` changed after deploy read it. Run deploy again.",
      );
    });

    it("in a resumed deploy, fail for a new version or a new item", async () => {
      const declared = source("stripe-key", reference);
      const state = { reference, revision: "version:stripe-id:1" };

      await setItems(appItems(2, "sk_live_2"));
      const resumed = await prefetch([{ id: "stripe-key", reference }]);
      await expect(load(declared, state, resumed.prefetched)).rejects.toThrow(
        "`op://Prod/Stripe/api key` changed after deploy read it. Run deploy again.",
      );

      await setItems({
        "Prod/Stripe": {
          item: item("Stripe", { id: "new-stripe-id" }, [
            { label: "api key", value: "sk_live_new" },
          ]),
        },
      });
      const replaced = await prefetch([{ id: "stripe-key", reference }]);
      await expect(load(declared, state, replaced.prefetched)).rejects.toThrow(
        ItemReplacedError,
      );
    });

    it("fail for a revision that does not match track, before any call", async () => {
      vi.stubEnv("NOTATION_TRACK_KEY", "track-key");
      const declared = source("stripe-key", reference);

      await expect(
        load(declared, {
          reference,
          track: "hmac",
          revision: "version:stripe-id:1",
        }),
      ).rejects.toThrow('does not match `track: "hmac"`');
      await expect(
        load(declared, { reference, revision: "stripe-id:1" }),
      ).rejects.toThrow("is not a revision of a 1Password secret");
      expect(await calls()).toHaveLength(0);
    });

    it("fail for an empty value", async () => {
      await setItems({
        "Prod/Empty": {
          item: item("Empty", {}, [{ label: "x", value: "" }, { label: "y" }]),
        },
      });

      for (const field of ["x", "y"]) {
        const text = `op://Prod/Empty/${field}`;
        await expect(
          read(source("empty", text), { reference: text }),
        ).rejects.toThrow(`The value of \`${text}\` is empty.`);
      }
    });
  });

  describe("fields", () => {
    const sections = () =>
      setItems({
        "Prod/Database": {
          item: item("Database", {}, [
            {
              label: "password",
              type: "CONCEALED",
              value: `${SENTINEL}-main`,
              section: { id: "main", label: "main" },
            },
            {
              label: "password",
              type: "CONCEALED",
              value: `${SENTINEL}-replica`,
              section: { id: "replica", label: "replica" },
            },
          ]),
        },
      });

    it("fail for a label in two sections without a section, and pass with one", async () => {
      await sections();

      const result = await prefetch([
        { id: "any", reference: "op://Prod/Database/password" },
        { id: "replica", reference: "op://Prod/Database/replica/password" },
      ]);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.id).toBe("any");
      const message = result.failed[0]!.error.message;
      expect(message).toBe(
        [
          "More than one field of the item matches `op://Prod/Database/password`. Add the section to the reference, or use the field's ID. The fields of the item are:",
          "  op://Prod/Database/main/password",
          "  op://Prod/Database/replica/password",
        ].join("\n"),
      );
      expect(message).not.toContain(SENTINEL);
      const declared = source("replica", "op://Prod/Database/replica/password");
      const revision = await read(
        declared,
        { reference: "op://Prod/Database/replica/password" },
        result.prefetched,
      );
      await expect(
        load(
          declared,
          { reference: "op://Prod/Database/replica/password", revision },
          result.prefetched,
        ),
      ).resolves.toBe(`${SENTINEL}-replica`);
    });

    it("match a field by its ID", async () => {
      await setItems({
        "Prod/Login": {
          item: item("Login", {}, [
            {
              id: "abcdefghijklmnopqrstuvwxyz",
              label: "token",
              value: "by-id",
            },
          ]),
        },
      });
      const text = "op://Prod/Login/abcdefghijklmnopqrstuvwxyz";
      const declared = source("login", text);

      const revision = await read(declared, { reference: text });
      await expect(load(declared, { reference: text, revision })).resolves.toBe(
        "by-id",
      );
    });

    it("fail for a field that isn't in the item", async () => {
      await sections();

      await expect(
        read(source("x", "op://Prod/Database/user"), {
          reference: "op://Prod/Database/user",
        }),
      ).rejects.toThrow(
        "No field of the item matches `op://Prod/Database/user`.",
      );
    });

    it("record the requested value of a text field, and no concealed value of four characters", async () => {
      await setItems({
        "Prod/Card": {
          item: item("Card", {}, [
            { label: "url", value: "postgres://db/card" },
            { label: "pin", type: "CONCEALED", value: "4321" },
            { label: "note", value: "a note of some length" },
            { label: "secret", type: "CONCEALED", value: "long-concealed" },
          ]),
        },
      });

      await prefetch([{ id: "card", reference: "op://Prod/Card/url" }]);

      expect(
        scrubSecretValues(
          "postgres://db/card 4321 a note of some length long-concealed",
        ),
      ).toBe("<hidden> 4321 a note of some length <hidden>");
    });

    it("keep only the values that a source asked for", async () => {
      await sections();

      const { prefetched } = await prefetch([
        { id: "main", reference: "op://Prod/Database/main/password" },
      ]);

      const kept = JSON.stringify([
        ...(prefetched as Map<string, unknown>).values(),
      ]);
      expect(kept).toContain(`${SENTINEL}-main`);
      expect(kept).not.toContain(`${SENTINEL}-replica`);
    });
  });

  describe("references", () => {
    it.each([
      [
        "op://Prod/-flag/x",
        "The item's name starts with `-`, which op would read as a flag. Use the item's ID instead.",
      ],
      [
        "op://Prod/Github/one-time password?attribute=otp",
        "A one-time password changes every 30 seconds, so it can't be deployed.",
      ],
      [
        "op://Prod/Server/key?ssh-format=openssh",
        "Query attributes, such as `?ssh-format=openssh`, are not supported.",
      ],
      [
        "op://Prod/Stripe",
        "Use the form `op://<vault>/<item>/[<section>/]<field>`.",
      ],
      ["op://Prod//x", "Use the form"],
      ["Prod/Stripe/key", "It must start with `op://`."],
    ])("rejects %s in the constructor", (reference, message) => {
      expect(() => source("bad", reference)).toThrow(message);
    });
  });

  describe("errors", () => {
    it("stops op after the time limit, and rejects with an error that concerns every item", async () => {
      await setItems({
        "Prod/Hung": {
          item: item("Hung", {}, [{ label: "x", value: "hung value" }]),
          delayMs: 5000,
        },
      });

      const error = await opItemGet("Hung", "Prod", 200).catch(
        (error: unknown) => error,
      );

      expect(error).toBeInstanceOf(OnePasswordError);
      expect((error as OnePasswordError).message).toBe(
        "op did not finish within 0.2 seconds, and was stopped.",
      );
      expect((error as OnePasswordError).stderr).not.toMatch(
        /isn't an item|isn't a vault|More than one item matches/,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await calls()).toEqual([]);
    });

    it("fail with a fixed message for output that isn't JSON, and never hold a value", async () => {
      await setItems({
        "Prod/Broken": { stdout: `{"fields":[{"value":"${SENTINEL}"` },
        "Prod/Invalid": {
          stdout: JSON.stringify({ id: 1, fields: [{ value: SENTINEL }] }),
        },
      });

      for (const name of ["Broken", "Invalid"]) {
        const text = `op://Prod/${name}/x`;
        const error = (await read(source("x", text), { reference: text }).catch(
          (error: unknown) => error,
        )) as Error;
        expect(error.message).toBe(
          "1Password returned output that notation can't read.",
        );
        expect(error.stack).not.toContain(SENTINEL);
        expect(error.cause).toBeUndefined();
      }
    });

    it("never hold a value from stdout or a recorded value in stderr, and pass no value as an argument", async () => {
      await setItems({
        "Prod/Stripe": {
          item: item("Stripe", {}, [
            { label: "api key", type: "CONCEALED", value: SENTINEL },
          ]),
        },
        "Prod/Failing": {
          stdout: SENTINEL,
          stderr: `[ERROR] 2026/11/19 12:00:00 something went wrong near ${SENTINEL}`,
        },
      });

      const error = (await prefetch([
        { id: "stripe-key", reference: "op://Prod/Stripe/api key" },
        { id: "failing", reference: "op://Prod/Failing/x" },
      ]).catch((error: unknown) => error)) as OnePasswordError;

      expect(error).toBeInstanceOf(OnePasswordError);
      expect(error.message).toBe(
        "op failed with exit code 1: something went wrong near <hidden>",
      );
      expect(error.stderr).not.toContain(SENTINEL);
      expect(error.stack).not.toContain(SENTINEL);
      for (const call of await calls()) {
        expect(call.args.join(" ")).not.toContain(SENTINEL);
      }
    });
  });
});
