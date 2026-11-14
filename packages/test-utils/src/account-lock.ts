import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll } from "vitest";

export type LockHolder = {
  /** Names the run that holds the lock, in the error of a run that waits. */
  holder: string;
  takenAt: Date;
};

export type LockRecord = LockHolder & { id: string };

/** Where the locks are kept. The tests of the lock logic pass a fake. */
export type LockStore = {
  /**
   * Creates the lock named `name` and returns its ID. Returns `undefined`
   * if a lock with that name exists. Of several creates of the same name at
   * once, only one may succeed.
   */
  create(name: string, holder: LockHolder): Promise<string | undefined>;
  /** Returns `undefined` if there is no lock named `name`. */
  read(name: string): Promise<LockRecord | undefined>;
  /** Does nothing if there is no lock with the ID. */
  delete(id: string): Promise<void>;
};

export type AccountLockOptions = {
  /** How long to wait for another run to release the lock. */
  waitMs?: number;
  /** A lock older than this belongs to a run that was killed, and is taken over. */
  maxAgeMs?: number;
  /** The delay between attempts to take the lock. */
  retryMs?: number;
  /** Names this run in the lock. Defaults to `defaultHolder`. */
  holder?: string;
  store?: LockStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
};

export type HeldLock = {
  name: string;
  /** Deletes the lock if this run still holds it. */
  release(): Promise<void>;
};

const DEFAULT_WAIT_MS = 15 * 60_000;
const DEFAULT_MAX_AGE_MS = 30 * 60_000;
const DEFAULT_RETRY_MS = 10_000;

/** The machine and the process ID of this test run. */
export const defaultHolder = `${hostname()}:${process.pid}`;

export const lockName = (name: string) => `ne2e-lock-${name}`;

/**
 * Takes the account-wide lock named `name`. A test takes a lock before it
 * manages a resource that the account can have only one of, so that only one
 * test run at a time uses it.
 *
 * If another run holds the lock, this retries until `waitMs` (15 minutes)
 * passes, and then throws an error that names the holder. A lock older than
 * `maxAgeMs` (30 minutes) was left by a run that was killed, so this deletes
 * it and takes it.
 *
 * By default the lock is a secret named `ne2e-lock-<name>` in the Cloudflare
 * Secrets Store of `CLOUDFLARE_ACCOUNT_ID`. `CLOUDFLARE_API_TOKEN` needs the
 * Secrets Store: Edit permission. If the account has no store, one is created
 * and left.
 */
export async function takeAccountLock(
  name: string,
  options: AccountLockOptions = {},
): Promise<HeldLock> {
  const {
    waitMs = DEFAULT_WAIT_MS,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    retryMs = DEFAULT_RETRY_MS,
    holder = defaultHolder,
    store = secretsStoreLocks(),
    now = Date.now,
    sleep: wait = sleep,
  } = options;
  const fullName = lockName(name);
  const deadline = now() + waitMs;
  for (;;) {
    const id = await store.create(fullName, {
      holder,
      takenAt: new Date(now()),
    });
    if (id) {
      return {
        name: fullName,
        release: async () => {
          const held = await store.read(fullName);
          if (held?.id === id) await store.delete(id);
        },
      };
    }
    // `undefined` if the holder released the lock after the create failed.
    const current = await store.read(fullName);
    if (current && now() - current.takenAt.getTime() > maxAgeMs) {
      // Deleting by ID means that of two runs that steal the same stale lock,
      // the slower one can't delete the lock that the faster one then takes.
      // Both then try the create, and only one of them gets the lock.
      await store.delete(current.id);
      continue;
    }
    if (now() >= deadline) {
      const holder = current
        ? `${current.holder} took it at ${current.takenAt.toISOString()}.`
        : "Nothing holds it now.";
      throw new Error(
        `Timed out after ${Math.round(waitMs / 1000)}s waiting for the lock ${fullName}. ${holder}`,
      );
    }
    await wait(retryMs);
  }
}

/**
 * Runs `fn` while this run holds the account-wide lock named `name`, and
 * releases the lock afterwards.
 */
export async function withAccountLock<T>(
  name: string,
  fn: () => Promise<T>,
  options: AccountLockOptions = {},
): Promise<T> {
  const lock = await takeAccountLock(name, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/**
 * Holds the account-wide lock named `name` for the tests of the enclosing
 * `describe`. See `takeAccountLock`.
 *
 * Call it before the hooks that create and destroy the resource. Vitest runs
 * `afterAll` hooks in the reverse order that they were added, so the lock is
 * released after the resource is destroyed.
 *
 * ```ts
 * import { useAccountLock } from "@notation/test-utils";
 *
 * describeE2e("ContainerRegistry", () => {
 *   useAccountLock("container-registry");
 *   const project = useProject();
 *   // ...
 * });
 * ```
 */
export function useAccountLock(
  name: string,
  options: AccountLockOptions = {},
): void {
  let lock: HeldLock | undefined;
  beforeAll(
    async () => {
      lock = await takeAccountLock(name, options);
    },
    // The wait for another run can be longer than the hook timeout.
    (options.waitMs ?? DEFAULT_WAIT_MS) + 60_000,
  );
  afterAll(async () => {
    await lock?.release();
  });
}

type StoreSecret = {
  id: string;
  name: string;
  comment?: string;
  created: string;
  status: string;
};

/**
 * Keeps each lock as a secret in the account's Secrets Store. Cloudflare
 * refuses to create a secret whose name another secret in the store has, so
 * only one create of a name succeeds. A secret's value can't be read back, so
 * the holder and the time are kept in its comment.
 */
export function secretsStoreLocks(): LockStore {
  let store: Promise<string> | undefined;
  const secretsPath = async () => {
    store ??= accountStoreId();
    return `/secrets_store/stores/${await store}/secrets`;
  };
  return {
    async create(name, { holder, takenAt }) {
      const comment = JSON.stringify({
        holder,
        takenAt: takenAt.toISOString(),
      });
      const response = await api<StoreSecret[]>("POST", await secretsPath(), [
        { name, value: "lock", scopes: ["workers"], comment },
      ]);
      if (response.success) return response.result[0]!.id;
      if (
        response.errors.some((error) =>
          error.message.includes("secret_name_already_exists"),
        )
      ) {
        return undefined;
      }
      throw new Error(
        `Creating the lock ${name} failed: ${JSON.stringify(response.errors)}`,
      );
    },
    async read(name) {
      // `search` also matches part of a name, so the results are compared
      // with the name.
      const response = await api<StoreSecret[]>(
        "GET",
        `${await secretsPath()}?search=${encodeURIComponent(name)}&per_page=100`,
      );
      if (!response.success) {
        throw new Error(
          `Reading the lock ${name} failed: ${JSON.stringify(response.errors)}`,
        );
      }
      const secret = (response.result ?? []).find(
        (item) => item.name === name && item.status !== "deleted",
      );
      if (!secret) return undefined;
      return { id: secret.id, ...parseHolder(secret) };
    },
    async delete(id) {
      const response = await api("DELETE", `${await secretsPath()}/${id}`);
      if (!response.success && response.status !== 404) {
        throw new Error(
          `Deleting the lock ${id} failed: ${JSON.stringify(response.errors)}`,
        );
      }
    },
  };
}

// A secret whose comment isn't a holder record counts as taken when it was
// created, by an unknown run.
function parseHolder(secret: StoreSecret): LockHolder {
  try {
    const parsed = JSON.parse(secret.comment ?? "");
    const takenAt = new Date(parsed.takenAt);
    if (typeof parsed.holder === "string" && !isNaN(takenAt.getTime())) {
      return { holder: parsed.holder, takenAt };
    }
  } catch {}
  return { holder: "unknown", takenAt: new Date(secret.created) };
}

// Cloudflare allows one store per account. If the account has none, this
// creates one with the name that the dashboard gives it, and leaves it.
async function accountStoreId(): Promise<string> {
  const list = async () => {
    const response = await api<{ id: string }[]>(
      "GET",
      "/secrets_store/stores",
    );
    if (!response.success) {
      throw new Error(
        `Listing stores failed: ${JSON.stringify(response.errors)}`,
      );
    }
    return response.result?.[0]?.id;
  };
  const existing = await list();
  if (existing) return existing;
  const created = await api<{ id: string }>("POST", "/secrets_store/stores", {
    name: "default_secrets_store",
  });
  if (created.success) return created.result.id;
  // Another run created the store first.
  const other = await list();
  if (other) return other;
  throw new Error(`Creating a store failed: ${JSON.stringify(created.errors)}`);
}

/**
 * True when `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set. The
 * Secrets Store locks need both.
 */
export function hasCloudflareCredentials(): boolean {
  return Boolean(
    process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN,
  );
}

type ApiResponse<T> = {
  status: number;
  success: boolean;
  errors: { code?: number; message: string }[];
  result: T;
};

// Reads the credentials on each call, so that a test can set them after this
// module is imported.
async function api<T = any>(
  method: "GET" | "POST" | "DELETE",
  // The path after `/accounts/<id>`.
  path: string,
  body?: object,
): Promise<ApiResponse<T>> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error(
      "The account locks need CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.",
    );
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(body && { "Content-Type": "application/json" }),
      },
      body: body && JSON.stringify(body),
    },
  );
  const text = await response.text();
  let envelope: any = {};
  try {
    envelope = JSON.parse(text);
  } catch {
    envelope = { errors: [{ message: text.slice(0, 200) }] };
  }
  return {
    status: response.status,
    success: response.ok && envelope.success !== false,
    errors: envelope.errors ?? [],
    result: envelope.result,
  };
}
