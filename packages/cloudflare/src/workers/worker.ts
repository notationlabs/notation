import { filePaths, fromProjectRoot, toProjectRoot } from "@notation/core";
import {
  getDeclaredIn,
  onEvaluationEnd,
  perCollection,
  ResourceGroup,
  type DeclaredIn,
} from "@notation/resource";
import * as std from "@notation/std/resources";
import * as cloudflare from "src/resources";
import { assertWorkerId, workerNames, workerResourceId } from "src/id";
import type { Bindings, DurableObjectDeclaration, Worker } from "./declaration";
import { describeNamespace, registeredNamespace } from "./durable-object";
import { isJsonBinding } from "./json";
import type { SecretValueFrom } from "src/resources/secrets-store/secrets-store-secret";
import { isWorkerSecret, type WorkerSecretGroup } from "./secret";
import { boundSecret } from "./secrets-store";

// Always set: the build imports Node's built-in modules as `node:` modules,
// which workerd only provides under this flag.
const NODEJS_COMPAT = "nodejs_compat";

export type WorkerDeclarationConfig<Id extends string, B extends Bindings> = {
  /**
   * Keys the Worker in state. Deploy names the Worker in Cloudflare
   * `<app>--<stage>--<id>-<instance>` when it creates it, with 8 random hex
   * characters as the instance. Changing the id replaces the Worker.
   */
  id: Id;
  /**
   * The values that the Worker reads from `env`: a `$durableObject`
   * namespace, another Worker, a secret from `secretsStore.bind()` or
   * `workerSecret()`, an `R2Bucket`, a `KVNamespace`, a value from
   * `json()` or a string. Return an object literal with no spread or
   * computed keys.
   */
  bindings?: () => B;
  /** Such as `"2026-10-12"`. */
  compatibilityDate: string;
  /** `nodejs_compat` is always added. */
  compatibilityFlags?: string[];
  /** Serves the Worker on its workers.dev URL. Defaults to `true`, as in wrangler. */
  url?: boolean;
};

export type WorkerGroupConfig = {
  id: string;
  /** The bundle to upload, relative to the project root. */
  codePath: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  bindings: cloudflare.workers.WorkerBinding[];
  /** The `secret_text` bindings, each set by a `WorkerSecret`. */
  secrets: { name: string; valueFrom: SecretValueFrom }[];
  namespaces: cloudflare.workers.HostedNamespace[];
  /** The ids of the hosted namespaces that set `protect: false`. */
  unprotectedNamespaces?: string[];
  /** The namespaces that the Worker binds on other Workers. */
  boundNamespaces: cloudflare.workers.BoundNamespace[];
  url: boolean;
};

const workerGroupMark = Symbol.for("@notation/cloudflare/WorkerGroup");

export class WorkerGroup extends ResourceGroup<WorkerGroupConfig> {
  platform = "cloudflare";
  readonly code: std.fs.FileInstance;
  readonly script: cloudflare.workers.WorkerScriptInstance;
  readonly subdomain?: cloudflare.workers.WorkerSubdomainInstance;
  readonly secrets: cloudflare.workers.WorkerSecretInstance[];

  get [workerGroupMark]() {
    return true;
  }

  constructor(config: WorkerGroupConfig) {
    super("Worker", config.id, config);
    this.code = this.add(
      new std.fs.File(`worker:${config.id}:code`, {
        config: { filePath: config.codePath },
      }),
    );
    this.script = this.add(
      new cloudflare.workers.WorkerScript(workerResourceId(config.id), {
        config: {
          CompatibilityDate: config.compatibilityDate,
          CompatibilityFlags: config.compatibilityFlags,
          Bindings: config.bindings,
          DurableObjectNamespaces: config.namespaces,
          UnprotectedDurableObjects: config.unprotectedNamespaces,
          BoundDurableObjects: config.boundNamespaces,
        },
        dependencies: { code: this.code },
      }),
    );
    this.secrets = config.secrets.map(({ name, valueFrom }) =>
      this.add(
        new cloudflare.workers.WorkerSecret(
          `worker:${config.id}:secret:${name}`,
          {
            config: { Name: name, ValueFrom: valueFrom },
            dependencies: { script: this.script },
          },
        ),
      ),
    );
    if (config.url) {
      this.subdomain = this.add(
        new cloudflare.workers.WorkerSubdomain(
          `worker:${config.id}:subdomain`,
          { dependencies: { script: this.script } },
        ),
      );
    }
  }
}

export function isWorkerGroup(value: unknown): value is WorkerGroup {
  return (value as any)?.[workerGroupMark] === true;
}

type Entry = {
  declaration: Worker<any>;
  id: string;
  /** Names the Worker in errors, with its module if known. */
  describe: () => string;
  record: () => DeclaredIn;
  bindings: () => Bindings;
  /** `chain` lists the Workers being built whose bindings led to this one. */
  build: (chain?: Entry[]) => WorkerGroup;
  /**
   * Calls `callback` with the Worker's group once it is built. The Worker
   * may be in the middle of its own build, as it can bind the namespaces of
   * the Worker that binds it.
   */
  whenBuilt: (callback: (group: WorkerGroup) => void) => void;
};

const workerRegistration = Symbol.for("@notation/cloudflare/WorkerDeclaration");

const registeredWorker = (value: unknown): Entry | undefined =>
  typeof value === "object" && value !== null && workerRegistration in value
    ? (value as { [workerRegistration]: Entry })[workerRegistration]
    : undefined;

const declaredWorkers = perCollection(
  "@notation/cloudflare/workers",
  () => [] as Entry[],
);

/**
 * Declares a Cloudflare Worker. The module's default export is the handler.
 * `bindings` is called after all infra modules have loaded, so it can refer
 * to a Worker whose module imports this one.
 * @declaration shared: id, bindings; keys: bindings; entry: default; platform: workerd
 */
export function $worker<const Id extends string, B extends Bindings = {}>(
  config: WorkerDeclarationConfig<Id, B>,
): Worker<B> {
  assertWorkerId("$worker", config.id);
  if (typeof config.compatibilityDate !== "string") {
    throw new Error(
      `$worker({ id: "${config.id}" }) requires compatibilityDate, such as "2026-10-12". Cloudflare runs the Worker with the behaviour of the runtime on that date, so the date is set in the code, and changes only when you change it.`,
    );
  }
  const declaration = { id: config.id } as unknown as Worker<B>;
  let bindings: Bindings | undefined;
  let group: WorkerGroup | undefined;
  const waiting: ((group: WorkerGroup) => void)[] = [];

  const entry: Entry = {
    declaration,
    id: config.id,
    describe: () => {
      const where = getDeclaredIn(declaration)?.path;
      return `$worker({ id: "${config.id}" })${where ? ` in ${where}` : ""}`;
    },
    record: () => {
      const record = getDeclaredIn(declaration);
      if (!record) {
        throw new Error(
          `The Worker "${config.id}" has no module. The infra build records the module of each $worker call; run the infra through notation compile, plan or deploy.`,
        );
      }
      return record;
    },
    // Called once, after all infra modules have loaded.
    bindings: () => (bindings ??= config.bindings?.() ?? {}),
    // A Worker that is already in `chain` means the bindings form a cycle.
    build: (chain = []) => {
      if (group) return group;
      if (chain.includes(entry)) {
        throw bindingCycleError([...chain.slice(chain.indexOf(entry)), entry]);
      }
      // The hosts of the namespaces that the Worker binds are built first,
      // as the bindings refer to their scripts.
      const resolved = resolveBindings(
        entry,
        (host) => host.build([...chain, entry]).script,
      );
      const record = entry.record();
      group = new WorkerGroup({
        id: config.id,
        codePath: toProjectRoot(
          filePaths.dist.runtime.index(fromProjectRoot(record.path)),
        ),
        compatibilityDate: config.compatibilityDate,
        compatibilityFlags: cloudflare.workers.sortedFlags([
          NODEJS_COMPAT,
          ...(config.compatibilityFlags ?? []),
        ]),
        bindings: resolved.bindings,
        secrets: resolved.secrets.map(({ name, secret }) => ({
          name,
          valueFrom: secret.valueFrom,
        })),
        namespaces: resolved.namespaces,
        // Undefined when empty, so that the params of a Worker deployed
        // before this option existed don't change.
        unprotectedNamespaces: resolved.unprotected.size
          ? [...resolved.unprotected].sort()
          : undefined,
        boundNamespaces: resolved.bound,
        url: config.url ?? true,
      });
      const { nameBody } = workerNames(config.id);
      for (const { name, secret } of resolved.secrets) {
        secret.boundBy({ nameBody, name });
      }
      // Each service binding is a contribution, so that deploy can create
      // one of two Workers that bind each other first, without its binding.
      // A binding of the Worker to itself refers to its own name, which is
      // no dependency.
      const script = group.script;
      for (const { name, worker } of resolved.services) {
        worker.whenBuilt((bound) =>
          script.contribute({
            Bindings: [
              {
                type: "service",
                name,
                service: bound.script.outputRef("ScriptName"),
              },
            ],
          }),
        );
      }
      // The Workers that bind a hosted namespace depend on this one, so their
      // names are read from state, with no dependency.
      for (const { id, binders } of resolved.transferSources) {
        for (const binder of binders) {
          binder.whenBuilt((bound) =>
            script.contribute({
              DurableObjectTransferSources: [
                {
                  namespaceId: id,
                  workerId: binder.id,
                  scriptName: bound.script["~state"].outputRef("ScriptName"),
                  ...workerNames(binder.id),
                },
              ],
            }),
          );
        }
      }
      for (const callback of waiting.splice(0)) callback(group);
      return group;
    },
    whenBuilt: (callback) => {
      if (group) callback(group);
      else waiting.push(callback);
    },
  };
  Object.defineProperty(declaration, workerRegistration, { value: entry });
  const workers = declaredWorkers();
  if (workers) {
    workers.push(entry);
    onEvaluationEnd(() => entry.build());
  }
  return declaration;
}

// Workers are built from onEvaluationEnd, when a collection is always
// active, so a missing store is a bug.
function active<T>(store: () => T | undefined, name: string): T {
  const value = store();
  if (value === undefined) {
    throw new Error(
      `@notation/cloudflare read its ${name} while no resource graph is being collected.`,
    );
  }
  return value;
}

function bindingCycleError(cycle: Entry[]): Error {
  const path = cycle.map((entry) => `"${entry.id}"`).join(" → ");
  return new Error(
    `The Workers ${path} bind each other's Durable Object namespaces in a cycle. Each Worker is uploaded after the hosts of the namespaces that it binds, so none of these Workers can be uploaded first. Move one of the namespaces to another Worker.`,
  );
}

type ResolvedBindings = {
  bindings: cloudflare.workers.WorkerBinding[];
  secrets: { name: string; secret: WorkerSecretGroup }[];
  namespaces: cloudflare.workers.HostedNamespace[];
  /** The ids of the hosted namespaces that set `protect: false`. */
  unprotected: Set<string>;
  bound: cloudflare.workers.BoundNamespace[];
  /** For each hosted namespace, the other Workers that bind it. */
  transferSources: { id: string; binders: Entry[] }[];
  /** The Workers that the Worker binds as services, itself included. */
  services: { name: string; worker: Entry }[];
};

/**
 * The Worker that binds a namespace and exports its class hosts it. Other
 * Workers that bind the namespace bind it on the host's script, which
 * `scriptOf` returns.
 */
function resolveBindings(
  self: Entry,
  scriptOf: (host: Entry) => cloudflare.workers.WorkerScriptInstance,
): ResolvedBindings {
  const resolved: ResolvedBindings = {
    bindings: [],
    secrets: [],
    namespaces: [],
    unprotected: new Set(),
    bound: [],
    transferSources: [],
    services: [],
  };
  for (const [name, value] of Object.entries(self.bindings())) {
    if (typeof value === "string") {
      resolved.bindings.push({ type: "plain_text", name, text: value });
      continue;
    }
    const namespace = registeredNamespace(value);
    if (namespace) {
      const ns = value as DurableObjectDeclaration;
      const host = hostOf(self, ns, namespace.className, name);
      if (host === self) {
        addHosted(self, resolved.namespaces, ns, namespace.className);
        if (!namespace.protect) resolved.unprotected.add(ns.id);
        addTransferSources(self, resolved.transferSources, ns);
        resolved.bindings.push({
          type: "durable_object_namespace",
          name,
          class_name: namespace.className,
        });
      } else {
        const scriptName = scriptOf(host).outputRef("ScriptName");
        resolved.bindings.push({
          type: "durable_object_namespace",
          name,
          class_name: namespace.className,
          script_name: scriptName,
        });
        if (!resolved.bound.some((bound) => bound.id === ns.id)) {
          resolved.bound.push({
            id: ns.id,
            className: namespace.className,
            scriptName,
          });
        }
      }
      continue;
    }
    const secret = boundSecret(value);
    if (secret) {
      // The output refs make the Worker depend on the secret, so the secret
      // exists when the Worker is uploaded. Cloudflare fails an upload that
      // binds a missing secret.
      const reference = secret["~secret"]();
      resolved.bindings.push({
        type: "secrets_store_secret",
        name,
        store_id: reference.outputRef("StoreId"),
        secret_name: reference.outputRef("Name"),
      });
      continue;
    }
    const worker = registeredWorker(value);
    if (worker) {
      resolved.services.push({ name, worker });
      continue;
    }
    if (isWorkerSecret(value)) {
      resolved.secrets.push({ name, secret: value });
      continue;
    }
    if (hasResourceType(value, "cloudflare/r2/R2Bucket")) {
      const bucket = value as cloudflare.r2.R2BucketInstance;
      // The name is an output ref, so that the Worker depends on the bucket.
      const jurisdiction = bucket.config.Jurisdiction;
      resolved.bindings.push({
        type: "r2_bucket",
        name,
        bucket_name: bucket.outputRef("BucketName"),
        ...(jurisdiction !== "default" ? { jurisdiction } : {}),
      });
      continue;
    }
    if (hasResourceType(value, "cloudflare/kv/KVNamespace")) {
      const kv = value as cloudflare.kv.KVNamespaceInstance;
      resolved.bindings.push({
        type: "kv_namespace",
        name,
        namespace_id: kv.outputRef("NamespaceId"),
      });
      continue;
    }
    if (isJsonBinding(value)) {
      resolved.bindings.push({ type: "json", name, json: value["~json"] });
      continue;
    }
    if (typeof value === "object" && value !== null && "~secret" in value) {
      throw new Error(
        `${self.describe()} binds ${name} to a secret directly. Bind it with \`${name}: secretsStore.bind(secret)\`.`,
      );
    }
    throw new Error(
      `${self.describe()} binds ${name} to a value that a Worker can't bind. Bind a Durable Object namespace from $durableObject, a Worker from $worker, a secret with secretsStore.bind() or workerSecret(), an R2Bucket, a KVNamespace, a value with json(), or a string.`,
    );
  }
  return resolved;
}

// Compared by type, not instanceof, so that a resource from another loaded
// copy of the package is still recognised.
const hasResourceType = (value: unknown, type: string): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as { type?: unknown }).type === type;

function addHosted(
  self: Entry,
  namespaces: cloudflare.workers.HostedNamespace[],
  namespace: DurableObjectDeclaration,
  className: string,
) {
  if (namespaces.some((hosted) => hosted.id === namespace.id)) return;
  const clash = namespaces.find((hosted) => hosted.className === className);
  if (clash) {
    throw new Error(
      `${self.describe()} hosts the namespaces "${clash.id}" and "${namespace.id}", which both have the class ${className}. Cloudflare keeps one namespace for each class that a Worker exports, so give each namespace its own class.`,
    );
  }
  namespaces.push({ id: namespace.id, className });
}

// A Worker that binds a namespace on its host may have hosted it before. It
// doesn't export the class, or it would host the namespace too.
function addTransferSources(
  self: Entry,
  sources: ResolvedBindings["transferSources"],
  namespace: DurableObjectDeclaration,
) {
  if (sources.some((source) => source.id === namespace.id)) return;
  const binders = active(declaredWorkers, "Workers").filter(
    (entry) =>
      entry !== self && Object.values(entry.bindings()).includes(namespace),
  );
  if (binders.length > 0) sources.push({ id: namespace.id, binders });
}

function hostOf(
  self: Entry,
  namespace: DurableObjectDeclaration,
  className: string,
  bindingName: string,
): Entry {
  const hosts = active(declaredWorkers, "Workers").filter(
    (entry) =>
      Object.values(entry.bindings()).includes(namespace) &&
      exportsOf(entry).includes(className),
  );
  if (hosts.length === 1) return hosts[0]!;
  if (hosts.length > 1) {
    const names = hosts.map((host) => `"${host.id}"`).join(" and ");
    throw new Error(
      `The Workers ${names} each export ${className} and bind ${describeNamespace(namespace)}, so each would host the namespace. Export the class from one of them. The others then bind the namespace on that Worker.`,
    );
  }
  const record = self.record();
  const stars =
    record.starExports && record.starExports.length > 0
      ? ` The bundle doesn't re-export the names of ${record.starExports.map((s) => `export * from ${JSON.stringify(s)}`).join(", ")}, so export ${className} by name.`
      : "";
  throw new Error(
    `${record.path} doesn't export ${className}, the class of ${describeNamespace(namespace)}, which the Worker "${self.id}" binds as ${bindingName}. Export the class from the Worker's module under that name, as Cloudflare finds the class by its export name, or from the module of another Worker that binds the namespace.${stars}`,
  );
}

// A Worker with no recorded module fails in its own build, so this returns
// no exports for it instead of throwing.
const exportsOf = (entry: Entry): string[] =>
  getDeclaredIn(entry.declaration)?.exports ?? [];
