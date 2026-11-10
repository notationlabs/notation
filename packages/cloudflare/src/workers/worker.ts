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
import {
  sortedFlags,
  type HostedNamespace,
  type WorkerBinding,
} from "src/resources/workers/worker-script";
import { assertWorkerId, workerName } from "src/id";
import type { Bindings, DurableObjectDeclaration, Worker } from "./declaration";
import { describeNamespace, registeredNamespace } from "./durable-object";

// The build imports Node's built-in modules as `node:` modules, which
// workerd provides under this flag, so every Worker gets it.
const NODEJS_COMPAT = "nodejs_compat";

export type WorkerDeclarationConfig<Id extends string, B extends Bindings> = {
  /**
   * Names the Worker, and keys it in state. The Worker is named
   * `<app>--<stage>--<id>` in Cloudflare. Changing the id replaces the
   * Worker, so keep it stable. Use 1 to 63 lowercase letters, digits or
   * hyphens.
   */
  id: Id;
  /**
   * The Worker's name in Cloudflare, in place of the id. The Worker is named
   * `<app>--<stage>--<name>`. Changing the name replaces the Worker.
   */
  name?: string;
  /**
   * The values that the Worker's code reads from `env`, by name, such as
   * `() => ({ COUNTERS: counters, GREETING: "hello" })`. A Durable Object
   * namespace from `$durableObject` is bound as a namespace, another Worker
   * as a service binding, and a string as plain text. Return an object
   * literal with no spread or computed keys.
   */
  bindings?: () => B;
  /**
   * The Worker's compatibility date, such as `"2026-10-12"`. Cloudflare
   * runs the Worker with the behaviour of the runtime on that date.
   */
  compatibilityDate: string;
  /**
   * The Worker's compatibility flags. `nodejs_compat` is always added, as
   * the build imports Node's built-in modules as `node:` modules.
   */
  compatibilityFlags?: string[];
  /**
   * Serves the Worker on its workers.dev URL. Defaults to `true`, as in
   * wrangler.
   */
  url?: boolean;
};

export type WorkerGroupConfig = {
  id: string;
  scriptName: string;
  /** The bundle to upload, relative to the project root. */
  codePath: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  bindings: WorkerBinding[];
  namespaces: HostedNamespace[];
  url: boolean;
};

const workerGroupMark = Symbol.for("@notation/cloudflare/WorkerGroup");

export class WorkerGroup extends ResourceGroup<WorkerGroupConfig> {
  platform = "cloudflare";
  readonly code: std.fs.FileInstance;
  readonly script: cloudflare.workers.WorkerScriptInstance;
  readonly subdomain?: cloudflare.workers.WorkerSubdomainInstance;

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
      new cloudflare.workers.WorkerScript(`worker:${config.id}`, {
        config: {
          ScriptName: config.scriptName,
          CompatibilityDate: config.compatibilityDate,
          CompatibilityFlags: config.compatibilityFlags,
          Bindings: config.bindings,
          DurableObjectNamespaces: config.namespaces,
        },
        dependencies: { code: this.code },
      }),
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
  scriptName: string;
  /** Describes the Worker in errors, with its module when it is known. */
  describe: () => string;
  record: () => DeclaredIn;
  bindings: () => Bindings;
  /** `chain` holds the Workers whose builds are building this one. */
  build: (chain?: Entry[]) => WorkerGroup;
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
const claimedNames = perCollection(
  "@notation/cloudflare/workerNames",
  () => new Map<string, string>(),
);

/**
 * Declares the Cloudflare Worker that its module deploys as. The module has
 * a default export, which Cloudflare calls with each request or event, and
 * exports the class of each Durable Object namespace that the Worker hosts.
 *
 * The Worker's resources are made when infra has finished loading, so the
 * bindings can refer to modules that import this one.
 * @declaration shared: id, bindings; keys: bindings; entry: default; platform: workerd
 */
export function $worker<const Id extends string, B extends Bindings = {}>(
  config: WorkerDeclarationConfig<Id, B>,
): Worker<B> {
  assertWorkerId("$worker", "id", config.id);
  if (config.name !== undefined) {
    assertWorkerId("$worker", "name", config.name);
  }
  if (typeof config.compatibilityDate !== "string") {
    throw new Error(
      `$worker({ id: "${config.id}" }) requires compatibilityDate, such as "2026-10-12". Cloudflare runs the Worker with the behaviour of the runtime on that date, so the date is set in the code, and changes only when you change it.`,
    );
  }
  const scriptName = workerName(config.name ?? config.id);
  const declaration = { id: config.id } as unknown as Worker<B>;
  let bindings: Bindings | undefined;
  let group: WorkerGroup | undefined;

  const entry: Entry = {
    declaration,
    id: config.id,
    scriptName,
    describe: () => {
      const options =
        config.name === undefined
          ? `id: "${config.id}"`
          : `id: "${config.id}", name: "${config.name}"`;
      const where = getDeclaredIn(declaration)?.path;
      return `$worker({ ${options} })${where ? ` in ${where}` : ""}`;
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
    // The bindings are read once, when infra has finished loading, as the
    // modules that they refer to may still be loading when $worker is called.
    bindings: () => (bindings ??= config.bindings?.() ?? {}),
    // A Worker is built after the Workers that it is uploaded after, so a
    // Worker that is already in `chain` closes a cycle of bindings.
    build: (chain = []) => {
      if (group) return group;
      if (chain.includes(entry)) {
        throw bindingCycleError([...chain.slice(chain.indexOf(entry)), entry]);
      }
      const resolved = resolveBindings(entry);
      const record = entry.record();
      const after = resolved.dependsOn.map(
        (other) => other.build([...chain, entry]).script,
      );
      claimName(scriptName, entry.describe());
      group = new WorkerGroup({
        id: config.id,
        scriptName,
        codePath: toProjectRoot(
          filePaths.dist.runtime.index(fromProjectRoot(record.path)),
        ),
        compatibilityDate: config.compatibilityDate,
        compatibilityFlags: sortedFlags([
          NODEJS_COMPAT,
          ...(config.compatibilityFlags ?? []),
        ]),
        bindings: resolved.bindings,
        namespaces: resolved.namespaces,
        url: config.url ?? true,
      });
      for (const script of after) group.script.dependOn(script);
      return group;
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

// A Worker is built from onEvaluationEnd, so a graph is always being
// collected while it is built.
function whileCollecting<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error(
      "@notation/cloudflare built a Worker while no resource graph is being collected.",
    );
  }
  return value;
}

function bindingCycleError(cycle: Entry[]): Error {
  const path = cycle.map((entry) => `"${entry.id}"`).join(" → ");
  return new Error(
    `The Workers ${path} bind each other in a cycle. Each Worker is uploaded after the Workers that it binds, and after the hosts of the namespaces that it binds, so none of these Workers can be uploaded first. Remove one of the bindings.`,
  );
}

function claimName(scriptName: string, declaration: string) {
  const claimed = whileCollecting(claimedNames());
  const previous = claimed.get(scriptName);
  if (previous) {
    throw new Error(
      `${previous} and ${declaration} give two Workers the same name, "${scriptName}". Give one of them another name.`,
    );
  }
  claimed.set(scriptName, declaration);
}

type ResolvedBindings = {
  bindings: WorkerBinding[];
  namespaces: HostedNamespace[];
  dependsOn: Entry[];
};

/**
 * Turns a Worker's bindings into the bindings of its upload. A Durable
 * Object namespace is hosted by the Worker that binds it and exports its
 * class. Each other Worker that binds the namespace binds it on that
 * Worker, and is uploaded after it.
 */
function resolveBindings(self: Entry): ResolvedBindings {
  const resolved: ResolvedBindings = {
    bindings: [],
    namespaces: [],
    dependsOn: [],
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
        resolved.bindings.push({
          type: "durable_object_namespace",
          name,
          class_name: namespace.className,
        });
      } else {
        resolved.bindings.push({
          type: "durable_object_namespace",
          name,
          class_name: namespace.className,
          script_name: host.scriptName,
        });
        resolved.dependsOn.push(host);
      }
      continue;
    }
    const worker = registeredWorker(value);
    if (worker) {
      resolved.bindings.push({
        type: "service",
        name,
        service: worker.scriptName,
      });
      if (worker !== self) resolved.dependsOn.push(worker);
      continue;
    }
    throw new Error(
      `${self.describe()} binds ${name} to a value that a Worker can't bind. Bind a Durable Object namespace from $durableObject, a Worker from $worker, or a string.`,
    );
  }
  return resolved;
}

function addHosted(
  self: Entry,
  namespaces: HostedNamespace[],
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

function hostOf(
  self: Entry,
  namespace: DurableObjectDeclaration,
  className: string,
  bindingName: string,
): Entry {
  const hosts = whileCollecting(declaredWorkers()).filter(
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

// Another Worker without a record fails its own build, so it is read here as
// exporting nothing.
const exportsOf = (entry: Entry): string[] =>
  getDeclaredIn(entry.declaration)?.exports ?? [];
