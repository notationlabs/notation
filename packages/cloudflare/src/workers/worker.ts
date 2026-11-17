import fs from "node:fs";
import { readEntryExports } from "@notation/build";
import { filePaths, fromProjectRoot, toProjectRoot } from "@notation/core";
import {
  all,
  captureCallSiteLazily,
  deferredOutputRef,
  evaluationEnded,
  getDeclaredIn,
  isCredentialRef,
  isDerived,
  isOutputRef,
  isStateRef,
  onEvaluationEnd,
  perCollection,
  ResourceGroup,
  type CredentialRef,
  type DeepInput,
  type OutputRef,
  type ResolvedValues,
} from "@notation/resource";
import * as std from "@notation/std/resources";
import { isBundle, type BundleLike } from "@notation/build/resources";
import * as cloudflare from "src/resources";
import {
  assertWorkerId,
  containerApplicationName,
  containerRepositoryName,
  workerNames,
  workerResourceId,
} from "src/id";
import type {
  Bindings,
  DurableObjectDeclaration,
  EntrypointType,
  Worker,
} from "./declaration";
import {
  describeNamespace,
  registeredNamespace,
  type DurableObjectContainerConfig,
  type Registered,
} from "./durable-object";
import type { Jurisdiction } from "src/api/r2";
import { isJsonBinding } from "./json";

// Always set: the build imports Node's built-in modules as `node:` modules,
// which workerd only provides under this flag.
const NODEJS_COMPAT = "nodejs_compat";

export type WorkerDeclarationConfig<
  Id extends string,
  B extends Bindings,
  E,
> = {
  /**
   * Keys the Worker in state. Deploy names the Worker in Cloudflare
   * `<app>--<stage>--<id>-<instance>` when it creates it, with 8 random hex
   * characters as the instance. Changing the id replaces the Worker.
   */
  id: Id;
  /**
   * The values that the Worker reads from `env`: a `$durableObject`
   * namespace, another Worker, a credential such as
   * `source.credentials.value` (a Worker secret), a `SecretsStoreSecret`, an
   * `R2Bucket`, a `KVNamespace`, a value from `json()`, or a string. A
   * string can be an output ref, or a derived value from `text` or `map`.
   * Return an object literal with no spread or computed keys.
   */
  bindings?: () => B;
  /** Such as `"2026-10-12"`. */
  compatibilityDate: string;
  /** `nodejs_compat` is always added. */
  compatibilityFlags?: string[];
  /**
   * Serves the Worker on its workers.dev URL. Defaults to `true`, as in
   * wrangler. With `false`, the Worker has no `url`.
   */
  url?: boolean;
  /**
   * The class that the module exports as its default, such as
   * `class Api extends WorkerEntrypoint`. A Worker that binds this Worker
   * gets `Service<Api>` in `env`, so its RPC calls are typed. The class
   * must be declared in the module, before `$worker`. Deploy doesn't read
   * the value.
   *
   * `worker()` takes `entrypointType<typeof Api>()` here, for the class that
   * its code file or bundle entry exports as its default. The build doesn't
   * check that the entry exports the class.
   */
  entrypoint?: E;
};

/** The options of `worker()`: the options of `$worker`, and `code`. */
export type WorkerConfig<
  Id extends string,
  B extends Bindings,
  E,
> = WorkerDeclarationConfig<Id, B, EntrypointType<E>> & {
  /**
   * A prebuilt JavaScript module, uploaded as-is, or a bundle from `bundle()`
   * with `platform: "workerd"`. File paths are relative to the project root.
   */
  code: { type: "file"; path: string } | BundleLike;
};

/**
 * The `url` of a Worker, unless its `url` option is `false`. A `boolean`
 * that isn't a literal gives `url`, and a read throws when it is `false`.
 */
export type WorkerUrl<U extends boolean> = [U] extends [false]
  ? {}
  : {
      /**
       * The Worker's workers.dev URL, which deploy fills in. Place it whole
       * in config, in a contribution or in a binding, or compute with it in
       * `text`, `map` or `all`. Worker code can't read it: bind it, and read
       * it from `env`.
       */
      readonly url: OutputRef<string>;
    };

/** The module that a Worker uploads: a file, or code declared elsewhere. */
export type WorkerGroupCode =
  | {
      /** The bundle to upload, relative to the project root. */
      codePath: string;
      code?: undefined;
    }
  | {
      codePath?: undefined;
      /**
       * Code declared outside the group, such as a bundle. The group depends
       * on it, but doesn't add it.
       */
      code: BundleLike;
    };

export type WorkerGroupConfig = WorkerGroupCode & {
  id: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  bindings: DeepInput<cloudflare.workers.WorkerBinding>[];
  /**
   * The `secret_text` bindings by name, each a credential of a resource,
   * which the upload of the code sends.
   */
  secrets: Record<string, CredentialRef<string>>;
  namespaces: cloudflare.workers.HostedNamespace[];
  /** The ids of the hosted namespaces that set `protect: false`. */
  unprotectedNamespaces?: string[];
  /** The namespaces that the Worker binds on other Workers. */
  boundNamespaces: DeepInput<cloudflare.workers.BoundNamespace>[];
  /** The containers of the hosted namespaces. */
  containers?: WorkerGroupContainer[];
  url: boolean;
};

/** The image and the container application of a hosted namespace. */
export type WorkerGroupContainer = {
  /** The id of the hosted namespace. */
  namespaceId: string;
  image: cloudflare.containers.ContainerImageInstance["config"];
  application: Omit<
    cloudflare.containers.ContainerApplicationInstance["config"],
    "HostedNamespaceId" | "Configuration"
  > & {
    Configuration: DeepInput<
      Omit<
        cloudflare.containers.ContainerApplicationSchema["CreateParams"]["Configuration"],
        "image"
      >
    >;
  };
};

const workerGroupMark = Symbol.for("@notation/cloudflare/WorkerGroup");

export class WorkerGroup extends ResourceGroup<WorkerGroupConfig> {
  platform = "cloudflare";
  readonly code: std.fs.FileInstance | BundleLike;
  readonly script: cloudflare.workers.WorkerScriptInstance;
  readonly subdomain?: cloudflare.workers.WorkerSubdomainInstance;
  readonly containers: {
    namespaceId: string;
    image: cloudflare.containers.ContainerImageInstance;
    application: cloudflare.containers.ContainerApplicationInstance;
  }[] = [];

  get [workerGroupMark]() {
    return true;
  }

  constructor(config: WorkerGroupConfig) {
    super("Worker", config.id, config);
    this.code =
      config.code ??
      this.add(
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
          // Undefined when empty, so that a read of a Worker with no secrets
          // doesn't list its secrets.
          Secrets: Object.keys(config.secrets).length
            ? config.secrets
            : undefined,
          DurableObjectNamespaces: config.namespaces,
          UnprotectedDurableObjects: config.unprotectedNamespaces,
          BoundDurableObjects: config.boundNamespaces,
        },
        dependencies: { code: this.code },
      }),
    );
    if (config.url) {
      this.subdomain = this.add(
        new cloudflare.workers.WorkerSubdomain(subdomainResourceId(config.id), {
          dependencies: { script: this.script },
        }),
      );
    }
    // The ids don't depend on the Worker, so that when the namespace moves
    // to another Worker, deploy changes the same resources.
    for (const { namespaceId, image, application } of config.containers ?? []) {
      const imageResource = this.add(
        new cloudflare.containers.ContainerImage(
          containerImageResourceId(namespaceId),
          { config: image },
        ),
      );
      const applicationResource = this.add(
        new cloudflare.containers.ContainerApplication(
          containerResourceId(namespaceId),
          {
            config: {
              ...application,
              HostedNamespaceId: namespaceId,
              Configuration: {
                image: imageResource.outputRef("Image"),
                ...application.Configuration,
              },
            },
            dependencies: { script: this.script },
          },
        ),
      );
      this.containers.push({
        namespaceId,
        image: imageResource,
        application: applicationResource,
      });
    }
  }
}

const subdomainResourceId = (id: string) => `worker:${id}:subdomain`;
const containerResourceId = (namespaceId: string) => `container:${namespaceId}`;
const containerImageResourceId = (namespaceId: string) =>
  `container:${namespaceId}:image`;

export function isWorkerGroup(value: unknown): value is WorkerGroup {
  return (value as any)?.[workerGroupMark] === true;
}

/** The exports of a Worker's module, which decide the namespaces it hosts. */
type WorkerExports = {
  names: string[];
  /** The sources of the module's `export * from` statements. */
  stars: string[];
  /**
   * Names the module at the start of a sentence in errors: its path, or the
   * entry of a bundle and the Worker that takes the bundle.
   */
  source: string;
  /** Names the module in advice: "the Worker's module" or "the entry". */
  module: string;
};

/** How a Worker was declared, and where its code comes from. */
type WorkerSource = {
  declaration: Worker<any>;
  /** Names the Worker in errors, with its module if known. */
  describe: () => string;
  /** Undefined when the module is not known. */
  exports: () => WorkerExports | undefined;
  code: () => WorkerGroupCode;
};

type Entry = WorkerSource & {
  id: string;
  /** The Worker's own bindings and the ones from `addBindings()`. */
  bindings: () => Bindings;
  /** The bindings from `addBindings()`, in the order of the calls. */
  added: AddedBindings[];
  /** `chain` lists the Workers being built whose bindings led to this one. */
  build: (chain?: Entry[]) => WorkerGroup;
  /**
   * Calls `callback` with the Worker's group once it is built. The Worker
   * may be in the middle of its own build, as it can bind the namespaces of
   * the Worker that binds it.
   */
  whenBuilt: (callback: (group: WorkerGroup) => void) => void;
};

type AddedBindings = {
  bindings: Bindings;
  /** The location of the code that called `addBindings()`. */
  caller: () => string;
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
 * @declaration shared: id, bindings; runtime: entrypoint; entryOption: entrypoint; keys: bindings; entry: default; platform: workerd; outputs: url
 */
export function $worker<
  const Id extends string,
  B extends Bindings = {},
  E = undefined,
  const U extends boolean = true,
>(
  config: WorkerDeclarationConfig<Id, B, E> & { url?: U },
): Worker<ResolvedValues<B>, E> & WorkerUrl<U> {
  assertWorkerId("$worker", config.id);
  assertCompatibilityDate(`$worker({ id: "${config.id}" })`, config);
  const declaration = { id: config.id } as unknown as Worker<
    ResolvedValues<B>,
    E
  > &
    WorkerUrl<U>;
  registerWorker(config, {
    declaration,
    describe: () => {
      const where = getDeclaredIn(declaration)?.path;
      return `$worker({ id: "${config.id}" })${where ? ` in ${where}` : ""}`;
    },
    exports: () => {
      const record = getDeclaredIn(declaration);
      if (!record) return undefined;
      return {
        names: record.exports ?? [],
        stars: record.starExports ?? [],
        source: record.path,
        module: "the Worker's module",
      };
    },
    code: () => {
      const record = getDeclaredIn(declaration);
      if (!record) throw noModuleError(config.id);
      return {
        codePath: toProjectRoot(
          filePaths.dist.runtime.index(fromProjectRoot(record.path)),
        ),
      };
    },
  });
  return declaration;
}

/**
 * Declares a Cloudflare Worker whose code is a prebuilt file or a bundle
 * from `bundle()`. It takes the options of `$worker`, and binds the same
 * values. Its `entrypoint` takes `entrypointType()`, as infra code can't load
 * the class. It hosts a Durable Object namespace that it binds when the file
 * or bundle's entry exports the namespace's class by name.
 * @resource
 */
export function worker<
  const Id extends string,
  B extends Bindings = {},
  E = undefined,
  const U extends boolean = true,
>(
  config: WorkerConfig<Id, B, E> & { url?: U },
): Worker<ResolvedValues<B>, E> & WorkerUrl<U> {
  assertWorkerId("worker()", config.id);
  const label = `worker({ id: "${config.id}" })`;
  assertCompatibilityDate(label, config);
  const { code } = config;
  const declaration = { id: config.id } as unknown as Worker<
    ResolvedValues<B>,
    E
  > &
    WorkerUrl<U>;
  if (!isBundle(code)) {
    if (code?.type !== "file" || typeof code.path !== "string" || !code.path) {
      throw new Error(
        `${label} expects code to be { type: "file", path: "path/to/worker.mjs" } or a bundle from bundle() in @notation/build/resources.`,
      );
    }
    const file = fromProjectRoot(code.path);
    let source: string;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(
        `${label} can't read its code file ${code.path} at ${file}. Pass an absolute path or a path relative to the project root.`,
        { cause: error },
      );
    }
    const exports = readEntryExports(file, source, "workerd");
    registerWorker(config, {
      declaration,
      describe: () => `${label} with the file ${code.path}`,
      exports: () => ({
        ...exports,
        source: `The code file of ${label}, ${code.path},`,
        module: "the code file",
      }),
      code: () => ({ codePath: toProjectRoot(file) }),
    });
    return declaration;
  }
  const { Entry, Platform } = code.config;
  if (Platform !== "workerd") {
    throw new Error(
      `${label} takes ${code.id} as its code, which is built for ${Platform}. Build the bundle with platform: "workerd".`,
    );
  }
  registerWorker(config, {
    declaration,
    describe: () => `${label} with the entry ${Entry}`,
    exports: () => ({
      ...code.exports,
      source: `The entry of ${label}, ${Entry},`,
      module: "the entry",
    }),
    code: () => ({ code }),
  });
  return declaration;
}

function assertCompatibilityDate(
  label: string,
  config: { compatibilityDate?: unknown },
) {
  if (typeof config.compatibilityDate !== "string") {
    throw new Error(
      `${label} requires compatibilityDate, such as "2026-10-12". Cloudflare runs the Worker with the behaviour of the runtime on that date, so the date is set in the code, and changes only when you change it.`,
    );
  }
}

const noModuleError = (id: string) =>
  new Error(
    `The Worker "${id}" has no module. The infra build records the module of each $worker call; run the infra through notation compile, plan or deploy.`,
  );

/**
 * Registers a Worker in the active collection. Its group is built when
 * evaluation ends, so that its bindings can refer to Workers declared after
 * it.
 */
function registerWorker(
  config: WorkerDeclarationConfig<string, Bindings, unknown>,
  source: WorkerSource,
) {
  let bindings: Bindings | undefined;
  let group: WorkerGroup | undefined;
  const waiting: ((group: WorkerGroup) => void)[] = [];

  const entry: Entry = {
    ...source,
    id: config.id,
    // Called once, after all infra modules have loaded. A name in the
    // Worker's own bindings is checked here, not in addBindings(), as
    // `config.bindings` is only called then.
    bindings: () => {
      if (bindings) return bindings;
      const own = config.bindings?.() ?? {};
      bindings = { ...own };
      for (const added of entry.added) {
        for (const [name, value] of Object.entries(added.bindings)) {
          if (Object.hasOwn(own, name)) {
            throw new Error(
              `addBindings() at ${added.caller()} binds ${name} on ${entry.describe()}, which already binds ${name} in its bindings. Give one of the bindings another name.`,
            );
          }
          bindings[name] = value;
        }
      }
      return bindings;
    },
    added: [],
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
      group = new WorkerGroup({
        ...entry.code(),
        id: config.id,
        compatibilityDate: config.compatibilityDate,
        compatibilityFlags: cloudflare.workers.sortedFlags([
          NODEJS_COMPAT,
          ...(config.compatibilityFlags ?? []),
        ]),
        bindings: resolved.bindings,
        secrets: resolved.secrets,
        namespaces: resolved.namespaces,
        // Undefined when empty, so that the params of a Worker deployed
        // before this option existed don't change.
        unprotectedNamespaces: resolved.unprotected.size
          ? [...resolved.unprotected].sort()
          : undefined,
        boundNamespaces: resolved.bound,
        // Undefined when empty, so that the config of a Worker without
        // containers stays the same.
        containers: resolved.containers.length
          ? resolved.containers
          : undefined,
        url: config.url ?? true,
      });
      // Each service binding is a contribution, so that deploy can create
      // one of two Workers that bind each other first, without its binding.
      // A binding of the Worker to itself refers to its own name, which is
      // no dependency.
      const script = group.script;
      // A plain text binding to an output ref is a contribution too, so that
      // a Worker can bind its own URL, or two Workers each other's.
      if (resolved.contributedText.length > 0) {
        script.contribute({ Bindings: resolved.contributedText });
      }
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
  Object.defineProperty(source.declaration, workerRegistration, {
    value: entry,
  });
  const workers = declaredWorkers();
  // The subdomain is built with the Worker, once every module has loaded, so
  // `url` is a deferred ref. It is not enumerable, as the registration isn't.
  let url: OutputRef<string> | undefined;
  Object.defineProperty(source.declaration, "url", {
    get: () => {
      if (config.url === false) {
        throw new Error(
          `url was read on ${entry.describe()}, which sets url: false, so it has no workers.dev URL. Remove url: false, or bind the Worker as a service.`,
        );
      }
      if (!workers) {
        throw new Error(
          `url was read on ${entry.describe()}, which was declared while no resource graph is being collected. Declare the Worker in an infra module, while the infra modules load.`,
        );
      }
      return (url ??= deferredOutputRef({
        resourceId: subdomainResourceId(config.id),
        key: "Url",
        // Not called during the Worker's own build: `group` isn't set until
        // the build returns, so the group would be built twice.
        resolve: () => entry.build().subdomain,
      }));
    },
  });
  if (workers) {
    workers.push(entry);
    onEvaluationEnd(() => entry.build());
  }
}

/**
 * Adds bindings to a Worker from other infra code, such as a library that
 * adds a feature to a Worker that it didn't declare. The values are the
 * ones that `bindings` accepts, and the Worker resolves them together with
 * its own bindings. `WorkerEnv` doesn't include them in its type.
 *
 * Call it while the infra modules load, from an infra module. It fails from
 * an `onEvaluationEnd` callback, as the Workers read their bindings once the
 * modules have loaded. A call in the module of a `$worker` fails the build,
 * as the infra build only keeps the declaration of such a module.
 * @resource
 */
export function addBindings(worker: Worker<any>, bindings: Bindings): void {
  const caller = captureCallSiteLazily(addBindings, {
    skipLibraryFrames: true,
  });
  const at = () => caller() ?? "an unknown location";
  const entry = registeredWorker(worker);
  if (!entry) {
    throw new Error(
      `addBindings() at ${at()} takes a Worker from $worker or worker() as its first argument.`,
    );
  }
  const workers = declaredWorkers();
  if (!workers) {
    throw new Error(
      `addBindings() at ${at()} was called for ${entry.describe()} while no resource graph is being collected. Call it from an infra module, while the infra modules load.`,
    );
  }
  if (!workers.includes(entry)) {
    throw new Error(
      `addBindings() at ${at()} was called for ${entry.describe()}, which was declared in another resource graph. Pass a Worker that is declared in the resource graph being collected.`,
    );
  }
  if (evaluationEnded()) {
    throw new Error(
      `addBindings() was called for ${entry.describe()} from an onEvaluationEnd callback, at ${at()}. Bindings are read once the infra modules have loaded, so addBindings() must be called while they load, such as in the function that declares what it binds.`,
    );
  }
  for (const name of Object.keys(bindings)) {
    const earlier = entry.added.find((added) =>
      Object.hasOwn(added.bindings, name),
    );
    if (earlier) {
      throw new Error(
        `addBindings() at ${at()} binds ${name} on ${entry.describe()}, which addBindings() already bound at ${earlier.caller()}. Give one of the bindings another name.`,
      );
    }
  }
  entry.added.push({ bindings: { ...bindings }, caller: at });
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
  bindings: DeepInput<cloudflare.workers.WorkerBinding>[];
  secrets: Record<string, CredentialRef<string>>;
  namespaces: cloudflare.workers.HostedNamespace[];
  /** The ids of the hosted namespaces that set `protect: false`. */
  unprotected: Set<string>;
  bound: { id: string; className: string; scriptName: OutputRef<string> }[];
  /** For each hosted namespace, the other Workers that bind it. */
  transferSources: { id: string; binders: Entry[] }[];
  /** The Workers that the Worker binds as services, itself included. */
  services: { name: string; worker: Entry }[];
  /** The plain text bindings to an output ref or a derived value. */
  contributedText: DeepInput<cloudflare.workers.WorkerBinding>[];
  containers: WorkerGroupContainer[];
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
    secrets: {},
    namespaces: [],
    unprotected: new Set(),
    bound: [],
    transferSources: [],
    services: [],
    contributedText: [],
    containers: [],
  };
  for (const [name, value] of Object.entries(self.bindings())) {
    if (isCredentialRef(value)) {
      resolved.secrets[name] = value as CredentialRef<string>;
      continue;
    }
    if (isStateRef(value)) {
      throw new Error(
        `${self.describe()} binds ${name} to a ~state ref. A binding needs a value at deploy, so use outputRef().`,
      );
    }
    if (typeof value === "string") {
      resolved.bindings.push({ type: "plain_text", name, text: value });
      continue;
    }
    if (isStateRef(value)) {
      throw new Error(
        `${self.describe()} binds ${name} to the ~state ref ${[value.resourceId, ...value.path].join(".")}. A ~state ref can only be placed whole in a contribution.`,
      );
    }
    if (isOutputRef(value) || isDerived(value)) {
      resolved.contributedText.push({
        type: "plain_text",
        name,
        text: value as DeepInput<string>,
      });
      continue;
    }
    const namespace = registeredNamespace(value);
    if (namespace) {
      const ns = value as DurableObjectDeclaration;
      const host = hostOf(self, ns, namespace.className, name);
      if (host === self) {
        if (addHosted(self, resolved.namespaces, ns, namespace)) {
          if (namespace.container) {
            resolved.containers.push(containerOf(ns.id, namespace.container));
          }
        }
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
    const worker = registeredWorker(value);
    if (worker) {
      resolved.services.push({ name, worker });
      continue;
    }
    if (hasResourceType(value, "cloudflare/r2/R2Bucket")) {
      const bucket = value as cloudflare.r2.R2BucketInstance;
      // The name is an output ref, so that the Worker depends on the bucket.
      // The jurisdiction decides whether the binding has the key. When it is
      // a ref or a derived value, the whole binding is a derived value, so
      // plan shows the binding as unknown until the jurisdiction is known.
      const bucketName = bucket.outputRef("BucketName");
      const jurisdiction = bucket.config.Jurisdiction;
      if (isCredentialRef(jurisdiction)) {
        throw new Error(
          `${self.describe()} binds ${name} to the R2 bucket ${bucket.id}, whose Jurisdiction is a credential. A binding records its jurisdiction as a plain param, so set it as a value or an output ref.`,
        );
      }
      resolved.bindings.push(
        typeof jurisdiction === "string"
          ? r2Binding(name, bucketName, jurisdiction)
          : all([jurisdiction, bucketName]).map(([jurisdiction, bucketName]) =>
              r2Binding(name, bucketName, jurisdiction),
            ),
      );
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
    if (hasResourceType(value, "cloudflare/secrets-store/SecretsStoreSecret")) {
      // The output refs make the Worker depend on the secret, so the secret
      // exists when the Worker is uploaded. Cloudflare fails an upload that
      // binds a missing secret.
      const secret =
        value as unknown as cloudflare.secretsStore.SecretsStoreSecretInstance;
      resolved.bindings.push({
        type: "secrets_store_secret",
        name,
        store_id: secret.outputRef("StoreId"),
        secret_name: secret.outputRef("Name"),
      });
      continue;
    }
    if (isJsonBinding(value)) {
      resolved.bindings.push({ type: "json", name, json: value["~json"] });
      continue;
    }
    throw new Error(
      `${self.describe()} binds ${name} to a value that a Worker can't bind. Bind a Durable Object namespace from $durableObject, a Worker from $worker or worker(), a credential such as \`source.credentials.value\`, a SecretsStoreSecret, an R2Bucket, a KVNamespace, a value with json(), or a string, which can be an output ref or a derived value.`,
    );
  }
  return resolved;
}

// Cloudflare takes no jurisdiction key for a bucket in the default
// jurisdiction.
function r2Binding<T extends string | OutputRef<string>>(
  name: string,
  bucketName: T,
  jurisdiction: Jurisdiction,
) {
  return {
    type: "r2_bucket" as const,
    name,
    bucket_name: bucketName,
    ...(jurisdiction !== "default" ? { jurisdiction } : {}),
  };
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
  { className, container }: Registered,
): boolean {
  if (namespaces.some((hosted) => hosted.id === namespace.id)) return false;
  const clash = namespaces.find((hosted) => hosted.className === className);
  if (clash) {
    throw new Error(
      `${self.describe()} hosts the namespaces "${clash.id}" and "${namespace.id}", which both have the class ${className}. Cloudflare keeps one namespace for each class that a Worker exports, so give each namespace its own class.`,
    );
  }
  // `container` is left out for a namespace without a container, so that the
  // params of a Worker deployed before this option existed don't change.
  namespaces.push({
    id: namespace.id,
    className,
    ...(container && { container: true }),
  });
  return true;
}

function containerOf(
  namespaceId: string,
  container: DurableObjectContainerConfig,
): WorkerGroupContainer {
  const { image, network } = container;
  const environmentVariables =
    typeof container.environmentVariables === "function"
      ? container.environmentVariables()
      : container.environmentVariables;
  return {
    namespaceId,
    image: {
      Repository: image.repository ?? containerRepositoryName(namespaceId),
      Context: image.context,
      ...(image.dockerfile !== undefined && { Dockerfile: image.dockerfile }),
      ...(image.buildArgs !== undefined && { BuildArgs: image.buildArgs }),
    },
    application: {
      Name: containerApplicationName(namespaceId),
      MaxInstances: container.maxInstances,
      Configuration: definedValues({
        instance_type: container.instanceType,
        vcpu: container.vcpu,
        memory_mib: container.memoryMib,
        disk:
          container.diskMb === undefined
            ? undefined
            : { size_mb: container.diskMb },
        environment_variables:
          environmentVariables &&
          Object.entries(environmentVariables).map(([name, value]) => ({
            name,
            value,
          })),
        network:
          network &&
          definedValues({
            mode: network.mode,
            assign_ipv4: network.assignIpv4,
            assign_ipv6: network.assignIpv6,
          }),
      }),
    },
  };
}

const definedValues = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;

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
  const own = self.exports();
  if (!own) throw noModuleError(self.id);
  const starList = own.stars
    .map((star) => `export * from ${JSON.stringify(star)}`)
    .join(", ");
  const stars =
    own.stars.length === 0
      ? ""
      : ` The names that ${starList} brings in are not known when the bindings are resolved, so export ${className} by name.`;
  throw new Error(
    `${own.source} doesn't export ${className}, the class of ${describeNamespace(namespace)}, which the Worker "${self.id}" binds as ${bindingName}. Export the class from ${own.module} under that name, as Cloudflare finds the class by its export name, or from the module of another Worker that binds the namespace.${stars}`,
  );
}

// A Worker with no recorded module fails in its own build, so this returns
// no exports for it instead of throwing.
const exportsOf = (entry: Entry): string[] => entry.exports()?.names ?? [];
