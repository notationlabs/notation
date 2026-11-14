import { execFile } from "node:child_process";
import crypto from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect } from "vitest";

const API_URL = "https://api.cloudflare.com/client/v4";

export const accountId = process.env.CLOUDFLARE_ACCOUNT_ID!;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

const hasCredentials = Boolean(accountId && apiToken);

/** A `describe` that is skipped when the Cloudflare credentials are not set. */
export function describeE2e(name: string, tests: () => void): void {
  describe.skipIf(!hasCredentials)(name, tests);
}

/**
 * Starts the name of everything that a test file creates, so that leftovers
 * can be found and two runs don't collide. Vitest evaluates this module once
 * for each test file.
 */
export const runPrefix = `ne2e-${crypto.randomBytes(3).toString("hex")}`;

// Inside this package, so that the project's imports of @notation packages
// resolve from this package's node_modules.
const tmpDir = fileURLToPath(new URL("../tmp", import.meta.url));
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(
  new URL("../node_modules/@notation/cli/dist/index.js", import.meta.url),
);

export type Project = {
  /** The project's directory. Set in `beforeAll`. */
  root: string;
  /** The start of the name of each Worker that deploy creates. */
  scope: string;
  /** The account's workers.dev subdomain. Set in `beforeAll`. */
  subdomain: string;
  write(file: string, contents: string): void;
  read(file: string): string;
  /** Runs the built CLI in the project, as a user would. */
  notation(command: "deploy" | "destroy"): Promise<void>;
  /** The names of the account's Workers that deploy created. */
  workerNames(): Promise<string[]>;
  /** The workers.dev URL of the Worker named `name`. */
  url(name: string): string;
};

/**
 * Sets up a temp project for the tests of the enclosing `describe`, with a
 * `notation.config.ts` whose app is `runPrefix`. After the tests, destroys
 * the deployment, deletes each Worker, R2 bucket and KV namespace that starts
 * with `runPrefix`, and checks that the account has none left.
 */
export function useProject({
  stage = "e2e",
  // Also deletes and checks the account tokens and Secrets Store secrets
  // that start with `runPrefix`. Listing them needs the token permissions
  // that only the token tests need.
  accountTokens = false,
  // Also deletes and checks the container applications that start with
  // `runPrefix`. Listing them needs the Containers permission that only the
  // Containers tests need.
  containers = false,
} = {}): Project {
  const scope = `${runPrefix}--${stage}--`;
  const project: Project = {
    root: "",
    scope,
    subdomain: "",
    write(file, contents) {
      const target = path.join(project.root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents);
    },
    read: (file) => readFileSync(path.join(project.root, file), "utf8"),
    notation: async (command) => {
      try {
        await promisify(execFile)(
          process.execPath,
          [
            cli,
            command,
            "--config",
            path.join(project.root, "notation.config.ts"),
          ],
          { cwd: project.root, env: process.env, maxBuffer: 16 * 1024 * 1024 },
        );
      } catch (error) {
        const { stdout, stderr } = error as {
          stdout?: string;
          stderr?: string;
        };
        throw new Error(`notation ${command} failed:\n${stdout}\n${stderr}`, {
          cause: error,
        });
      }
    },
    workerNames: () => scriptsWithPrefix(scope),
    url: (name) => `https://${name}.${project.subdomain}.workers.dev`,
  };

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    project.root = mkdtempSync(path.join(tmpDir, `${runPrefix}-`));
    // The project gets its own package.json, as this package's
    // `"sideEffects": false` would otherwise let the infra build drop the
    // project's modules. The build treats a bare import as a package only
    // when it is installed in a node_modules folder, so the project links
    // @notation/cloudflare into its own.
    project.write("package.json", `{ "private": true }`);
    const link = path.join(project.root, "node_modules/@notation/cloudflare");
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(packageDir, link, "dir");
    project.write(
      "notation.config.ts",
      `export default { app: "${runPrefix}", defaultStage: "${stage}", entry: "infra/main.ts" };`,
    );
    project.write("infra/main.ts", `export {};`);
    project.subdomain = await accountSubdomain();
  });

  afterAll(async () => {
    try {
      if (project.root) await project.notation("destroy");
    } finally {
      // Catches what a failed deploy or destroy left behind, and what a test
      // created through the API. Cloudflare refuses to delete a Worker while
      // a container application uses its namespace.
      if (containers) await deleteContainerApplicationsWithPrefix(runPrefix);
      await deleteScriptsWithPrefix(runPrefix);
      await deleteBucketsWithPrefix(runPrefix);
      await deleteKvNamespacesWithPrefix(runPrefix);
      if (accountTokens) await deleteTokensAndSecretsWithPrefix(runPrefix);
      if (project.root) rmSync(project.root, { recursive: true, force: true });
    }
    expect(await scriptsWithPrefix(runPrefix)).toEqual([]);
    expect(await namespacesWithPrefix(runPrefix)).toEqual([]);
    expect(await bucketsWithPrefix(runPrefix)).toEqual([]);
    expect(await kvNamespacesWithPrefix(runPrefix)).toEqual([]);
    if (containers) {
      expect(await containerApplicationsWithPrefix(runPrefix)).toEqual([]);
    }
    if (accountTokens) {
      expect(await tokensWithPrefix(runPrefix)).toEqual([]);
      expect(await secretsWithPrefix(runPrefix)).toEqual([]);
    }
  });

  return project;
}

export type ApiResponse<T> = {
  status: number;
  success: boolean;
  errors: { code?: number; message: string }[];
  result: T;
};

/** Calls the Cloudflare API, and returns the envelope instead of throwing. */
export async function api<T = any>(
  method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE",
  /** The path after `/accounts/<id>`. */
  path: string,
  body?: FormData | object,
  requestHeaders: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    ...requestHeaders,
    Authorization: `Bearer ${apiToken}`,
  };
  let payload: FormData | string | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${API_URL}/accounts/${accountId}${path}`, {
    method,
    headers,
    body: payload,
  });
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

async function accountSubdomain(): Promise<string> {
  const response = await api<{ subdomain: string }>(
    "GET",
    "/workers/subdomain",
  );
  if (!response.success) {
    throw new Error(
      `The account has no workers.dev subdomain: ${JSON.stringify(response.errors)}`,
    );
  }
  return response.result.subdomain;
}

/** The names of the account's Workers that start with `prefix`. */
export async function scriptsWithPrefix(prefix: string): Promise<string[]> {
  const response = await api<{ id: string }[]>("GET", "/workers/scripts");
  if (!response.success) {
    throw new Error(
      `Listing Workers failed: ${JSON.stringify(response.errors)}`,
    );
  }
  return response.result
    .map((script) => script.id)
    .filter((name) => name.startsWith(prefix))
    .sort();
}

export type AccountNamespace = { script: string; class: string };

/** The account's Durable Object namespaces whose Worker starts with `prefix`. */
export async function namespacesWithPrefix(
  prefix: string,
): Promise<AccountNamespace[]> {
  const found: AccountNamespace[] = [];
  for (let page = 1; ; page++) {
    const response = await api<AccountNamespace[]>(
      "GET",
      `/workers/durable_objects/namespaces?page=${page}&per_page=1000`,
    );
    if (!response.success) {
      throw new Error(
        `Listing namespaces failed: ${JSON.stringify(response.errors)}`,
      );
    }
    if (!response.result?.length) break;
    for (const namespace of response.result) {
      if (namespace.script?.startsWith(prefix)) {
        found.push({ script: namespace.script, class: namespace.class });
      }
    }
  }
  return found;
}

export type AccountBucket = { name: string; jurisdiction: string };

// The list of buckets has only the buckets of the jurisdiction that the
// request names, so each jurisdiction that the tests use is listed.
const bucketJurisdictions = ["default", "eu"];

/** The account's R2 buckets whose name starts with `prefix`. */
export async function bucketsWithPrefix(
  prefix: string,
): Promise<AccountBucket[]> {
  const found: AccountBucket[] = [];
  for (const jurisdiction of bucketJurisdictions) {
    const response = await api<{ buckets: { name: string }[] }>(
      "GET",
      `/r2/buckets?name_contains=${prefix}&per_page=1000`,
      undefined,
      { "cf-r2-jurisdiction": jurisdiction },
    );
    if (!response.success) {
      throw new Error(
        `Listing the R2 buckets in the ${jurisdiction} jurisdiction failed: ${JSON.stringify(response.errors)}`,
      );
    }
    for (const bucket of response.result.buckets) {
      if (bucket.name.startsWith(prefix)) {
        found.push({ name: bucket.name, jurisdiction });
      }
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function deleteBucketsWithPrefix(prefix: string): Promise<void> {
  for (const bucket of await bucketsWithPrefix(prefix)) {
    await api("DELETE", `/r2/buckets/${bucket.name}`, undefined, {
      "cf-r2-jurisdiction": bucket.jurisdiction,
    });
  }
}

async function deleteScriptsWithPrefix(prefix: string): Promise<void> {
  for (const name of await scriptsWithPrefix(prefix)) {
    await api("DELETE", `/workers/scripts/${name}?force=true`);
  }
}

export type AccountTokenSummary = {
  id: string;
  name: string;
  status: string;
  modified_on: string;
  policies: {
    effect: string;
    permission_groups: { id: string; name: string }[];
    resources: Record<string, unknown>;
  }[];
  condition?: {
    request_ip?: { in?: string[] | null; not_in?: string[] | null } | null;
  } | null;
  expires_on?: string | null;
  not_before?: string | null;
};

/** The account's API tokens whose name starts with `prefix`. */
export async function tokensWithPrefix(
  prefix: string,
): Promise<AccountTokenSummary[]> {
  const found: AccountTokenSummary[] = [];
  for (let page = 1; ; page++) {
    const response = await api<AccountTokenSummary[]>(
      "GET",
      `/tokens?page=${page}&per_page=50`,
    );
    if (!response.success) {
      throw new Error(
        `Listing tokens failed: ${JSON.stringify(response.errors)}`,
      );
    }
    const tokens = response.result ?? [];
    found.push(...tokens.filter((token) => token.name.startsWith(prefix)));
    if (tokens.length < 50) return found;
  }
}

export type StoreSecretSummary = { id: string; name: string; status: string };

/** The account's store ID, or `undefined` if the account has no store. */
async function storeId(): Promise<string | undefined> {
  const response = await api<{ id: string }[]>("GET", "/secrets_store/stores");
  if (!response.success) {
    throw new Error(
      `Listing stores failed: ${JSON.stringify(response.errors)}`,
    );
  }
  return response.result?.[0]?.id;
}

/**
 * The Secrets Store secrets whose name starts with `prefix`, except those
 * with the status `deleted`.
 */
export async function secretsWithPrefix(
  prefix: string,
): Promise<StoreSecretSummary[]> {
  const store = await storeId();
  if (!store) return [];
  const found: StoreSecretSummary[] = [];
  for (let page = 1; ; page++) {
    const response = await api<StoreSecretSummary[]>(
      "GET",
      `/secrets_store/stores/${store}/secrets?search=${prefix}&page=${page}&per_page=100`,
    );
    if (!response.success) {
      throw new Error(
        `Listing secrets failed: ${JSON.stringify(response.errors)}`,
      );
    }
    const secrets = response.result ?? [];
    for (const secret of secrets) {
      if (secret.name.startsWith(prefix) && secret.status !== "deleted") {
        found.push({ id: secret.id, name: secret.name, status: secret.status });
      }
    }
    if (secrets.length < 100) return found;
  }
}

async function deleteTokensAndSecretsWithPrefix(prefix: string) {
  for (const token of await tokensWithPrefix(prefix)) {
    await api("DELETE", `/tokens/${token.id}`);
  }
  const store = await storeId();
  for (const secret of await secretsWithPrefix(prefix)) {
    await api("DELETE", `/secrets_store/stores/${store}/secrets/${secret.id}`);
  }
}

export type KvNamespace = { id: string; title: string };

/** The account's KV namespaces whose title starts with `prefix`. */
export async function kvNamespacesWithPrefix(
  prefix: string,
): Promise<KvNamespace[]> {
  const found: KvNamespace[] = [];
  for (let page = 1; ; page++) {
    const response = await api<KvNamespace[]>(
      "GET",
      `/storage/kv/namespaces?page=${page}&per_page=1000&order=id&direction=asc`,
    );
    if (!response.success) {
      throw new Error(
        `Listing KV namespaces failed: ${JSON.stringify(response.errors)}`,
      );
    }
    if (!response.result?.length) break;
    for (const namespace of response.result) {
      if (namespace.title.startsWith(prefix)) {
        found.push({ id: namespace.id, title: namespace.title });
      }
    }
  }
  return found;
}

async function deleteKvNamespacesWithPrefix(prefix: string): Promise<void> {
  for (const namespace of await kvNamespacesWithPrefix(prefix)) {
    await api("DELETE", `/storage/kv/namespaces/${namespace.id}`);
  }
}

export type ContainerApplication = {
  id: string;
  name: string;
  max_instances: number;
  configuration: {
    image: string;
    vcpu?: number;
    memory_mib?: number;
    disk?: { size_mb: number };
    environment_variables?: { name: string; value: string }[];
  };
  durable_objects?: { namespace_id: string };
  active_rollout_id?: string;
};

/** The account's container applications whose name starts with `prefix`. */
export async function containerApplicationsWithPrefix(
  prefix: string,
): Promise<ContainerApplication[]> {
  const response = await api<ContainerApplication[] | null>(
    "GET",
    "/containers/applications",
  );
  if (!response.success) {
    throw new Error(
      `Listing container applications failed: ${JSON.stringify(response.errors)}`,
    );
  }
  return (response.result ?? []).filter((application) =>
    application.name.startsWith(prefix),
  );
}

async function deleteContainerApplicationsWithPrefix(
  prefix: string,
): Promise<void> {
  for (const application of await containerApplicationsWithPrefix(prefix)) {
    await api("DELETE", `/containers/applications/${application.id}`);
  }
}

/** The IDs of the Worker's versions, the latest first. */
export async function versionIds(name: string): Promise<string[]> {
  const response = await api<{ items: { id: string }[] }>(
    "GET",
    `/workers/scripts/${name}/versions`,
  );
  if (!response.success) {
    throw new Error(
      `Listing the versions of ${name} failed: ${JSON.stringify(response.errors)}`,
    );
  }
  return response.result.items.map((item) => item.id);
}

export type Fetched = {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
};

/**
 * Requests `url` until `done` holds for the response or `timeoutMs` passes,
 * as a new workers.dev hostname or version takes a while to be served.
 * Returns the last response or error.
 */
export async function poll(
  url: string,
  {
    timeoutMs = 120_000,
    done = (fetched: Fetched) => fetched.ok,
  }: { timeoutMs?: number; done?: (fetched: Fetched) => boolean } = {},
): Promise<Fetched> {
  const deadline = Date.now() + timeoutMs;
  let last: Fetched = { ok: false };
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      last = {
        ok: response.ok,
        status: response.status,
        body: (await response.text()).slice(0, 500),
      };
    } catch (error) {
      const cause = (error as Error & { cause?: any }).cause;
      last = {
        ok: false,
        error: `${(error as Error).name}: ${cause?.code ?? cause?.message ?? (error as Error).message}`,
      };
    }
    if (done(last)) return last;
    await sleep(3_000);
  }
  return last;
}
