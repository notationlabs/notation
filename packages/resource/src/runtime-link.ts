import { captureCallSite, captureCallSiteLazily } from "./contributions";
import {
  deferredMark,
  isOutputValue,
  isPlainObject,
  resolveDeferred,
} from "./output-value";
import { bindingKey, outputKey, parseOutputKey } from "./outputs";
import { getActiveResourceCollection } from "./resource-collection";
import type { RuntimeRef } from "./views";

/** A handler of a runtime function, found when the infra phase linked it. */
export type RuntimeHandler = {
  /** The runtime module that exports the handler, relative to the project root. */
  module: string;
  /** The export's name, which the function's dispatch map uses. */
  export: string;
  kind: string;
};

/** A function that a runtime module declared, as the compiler bundles it. */
export type RuntimeFunction = {
  id: string;
  /** The provider service, such as `aws/lambda`. */
  service: string;
  /** The path of the bundle's entry file, relative to the project root. */
  bundle: string;
  handlers: RuntimeHandler[];
};

/**
 * Gives a function the values that its code reads from infra, keyed by
 * output key, such as `infra/orders#orderQueue.url`. Values may be output
 * values, which resolve at deploy.
 */
export type DeliverValues = (values: Record<string, unknown>) => void;

export type RuntimeRegistry = {
  handlers: HandlerRef[];
  // Set once `linkRuntimeModules` has named the exported handlers.
  linked: boolean;
  functions: Array<{
    fn: object;
    info: RuntimeFunction;
    declaredAt?: string;
    deliver?: DeliverValues;
  }>;
};

const handlerRefMark = Symbol.for("@notation/resource/HandlerRef");
const standInMark = Symbol.for("@notation/resource/StandIn");

/**
 * What `handle.<kind>(fn)` returns in the infra phase. It holds the function
 * it belongs to and the kind of event it takes, not the handler's code. The
 * infra phase names it after its export when it links the runtime modules.
 *
 * Types call it a `Handler`, as runtime code sees it, and infra sees it as a
 * `RuntimeRef` through `InfraView`.
 */
export class HandlerRef<F = unknown> implements RuntimeRef<any, unknown, F> {
  readonly kind: string;
  readonly function: F;
  declare readonly "~notation.runtimeRef": RuntimeRef<
    any,
    unknown,
    F
  >["~notation.runtimeRef"];
  readonly declaredAt?: string;
  module?: string;
  export?: string;

  constructor(kind: string, fn: F, declaredAt?: string) {
    this.kind = kind;
    this.function = fn;
    this.declaredAt = declaredAt;
  }

  get [handlerRefMark]() {
    return true;
  }

  wire(kind: string, wire: (fn: F, exportName: string) => void): void {
    if (this.export === undefined) {
      if (getActiveResourceCollection()?.runtime.linked) {
        throw new Error(notExported(this));
      }
      throw new Error(
        `The ${this.kind} handler made${madeAt(this)} was wired before the runtime modules were linked, so its export isn't known yet. Import its runtime module with { type: "runtime" }, and pass infra the handler from that import.`,
      );
    }
    if (this.kind !== kind) {
      throw new Error(
        `${this.export} from ${this.module} handles ${this.kind} events, but it was wired to a source of ${kind} events.`,
      );
    }
    wire(this.function, this.export);
  }
}

function notExported(ref: HandlerRef): string {
  return `The ${ref.kind} handler made${madeAt(ref)} isn't exported from a runtime module. Export it, so that infra can wire it and its function can dispatch to it.`;
}

function madeAt(ref: HandlerRef): string {
  return ref.declaredAt ? ` at ${ref.declaredAt}` : "";
}

/**
 * Makes a handler reference for `fn`, and registers it so that linking fails
 * if no runtime module exports it. `below` is the provider function that the
 * user's code called. The call site is taken from the frame that called
 * `below`, so that it points at the user's `handle` call.
 */
export function createHandlerRef<F>(
  kind: string,
  fn: F,
  below: Function,
): HandlerRef<F> {
  const declaredAt = captureCallSite(below, { skipLibraryFrames: true });
  const ref = new HandlerRef(kind, fn, declaredAt);
  getActiveResourceCollection()?.runtime.handlers.push(ref);
  return ref;
}

export function isHandlerRef(value: unknown): value is HandlerRef {
  return (value as any)?.[handlerRefMark] === true;
}

/**
 * Registers a function that a runtime module declares. Once the runtime
 * modules are linked, the function's handlers are the exported handler
 * references that hold `fn`.
 * @param deliver Gives the function the values that its bundle reads from
 * infra. A function without it can't read infra.
 */
export function declareRuntimeFunction(
  fn: object,
  info: Omit<RuntimeFunction, "handlers">,
  below: Function,
  deliver?: DeliverValues,
): void {
  const collection = getActiveResourceCollection();
  if (!collection) return;
  const declaredAt = captureCallSite(below, { skipLibraryFrames: true });
  collection.runtime.functions.push({
    fn,
    info: { ...info, handlers: [] },
    declaredAt,
    deliver,
  });
}

type StandInState = {
  module: string;
  name: string;
  linked: boolean;
  value: unknown;
  // Calls that infra made on the stand-in's function before linking, such
  // as `createOrder.function.policy.contribute(...)`. Linking runs them.
  calls: Array<() => unknown>;
};

/**
 * What infra sees in place of an export of a runtime module, while the
 * runtime module has not run. After linking, it reads through to the export.
 * Before, each property read gives a chain that resolves once linked, as
 * values read from a handler's function do; see `createChain`. `function` is
 * the export's function: the handler's function, or the export itself for an
 * exported `lambda()` result. Reading `id`, or turning the stand-in into a
 * string, fails before linking.
 * @param module The runtime module, relative to the project root.
 */
export function createStandIn(
  module: string,
  name: string,
): RuntimeRef<any, unknown, unknown> {
  const state: StandInState = {
    module,
    name,
    linked: false,
    value: undefined,
    calls: [],
  };
  let lazyFunction: object | undefined;
  const resolve = () => {
    if (!state.linked) throw new Error(notLinked(state));
    return exportOf(state);
  };
  const get = (_: object, prop: string | symbol): unknown => {
    if (prop === standInMark) return state;
    if (prop === deferredMark) return resolve;
    if (state.linked) {
      if (prop === "function") return functionOf(state);
      return readLinked(exportOf(state), prop);
    }
    if (prop === "then") return undefined;
    if (prop === "function") {
      return (lazyFunction ??= createChain(
        state,
        `${name}.function`,
        () => undefined,
        () => ({ value: functionOf(state) }),
        true,
      ));
    }
    if (prop === "id" || stringifyingProps.has(prop)) {
      throw new Error(unknownUse(name, prop, at(get)));
    }
    if (typeof prop === "symbol") return undefined;
    return createChain(
      state,
      `${name}.${prop}`,
      captureCallSiteLazily(get, { skipLibraryFrames: true }),
      () => {
        const holder = exportOf(state);
        return { value: Reflect.get(Object(holder), prop, holder), holder };
      },
    );
  };
  const has = (_: object, prop: string | symbol): boolean => {
    if (prop === "function") return true;
    if (state.linked) return prop in Object(exportOf(state));
    return readableBeforeLinking(prop);
  };
  return new Proxy({}, { get, has, set: readOnly(name) }) as RuntimeRef<
    any,
    unknown,
    unknown
  >;
}

export function isStandIn(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    standInState(value) !== undefined
  );
}

/** `<export> from <module>` for a stand-in, or undefined for other values. */
export function describeStandIn(value: unknown): string | undefined {
  if (!isStandIn(value)) return undefined;
  const state = standInState(value as object)!;
  return `${state.name} from ${state.module}`;
}

/**
 * Finds what a stand-in, or a stand-in's `function`, stands for. Any other
 * value is returned as it is. Fails if the stand-in is not linked yet.
 */
export function resolveRuntimeTarget(value: unknown): unknown {
  if (typeof value !== "object" && typeof value !== "function") return value;
  if (value === null) return value;
  const standIn = standInState(value);
  const state = standIn ?? lazyFunctionState(value);
  if (state && !state.linked) throw new Error(notLinked(state));
  return standIn ? exportOf(standIn) : resolveDeferred(value);
}

/** A runtime module's stand-in exports, and the exports of its stripped copy. */
export type RuntimeModuleLink = {
  /** The runtime module, relative to the project root. */
  module: string;
  standIns: Record<string, unknown>;
  exports: Record<string, unknown>;
};

/**
 * The last step of the infra phase, which generated code calls once the
 * stripped copies of the runtime modules have run:
 *
 * 1. Each exported handler is named after its export. A handler exported
 *    under several names keeps the first, in order of module and name.
 * 2. Each stand-in links to the export it names.
 * 3. A handler that no runtime module exports fails, naming its `handle`
 *    call.
 * 4. Each declared function gets its handlers, and goes in the graph's
 *    `runtimeFunctions`, sorted by ID.
 * 5. When the graph is collected with `runtimeReads`, each function gets the
 *    values that its bundle reads from infra.
 * @param infraModules The exports of each infra module that runtime code
 * imports `with { type: "infra" }`, keyed by its path relative to the project
 * root, without its extension.
 */
export function linkRuntimeModules(
  modules: RuntimeModuleLink[],
  infraModules: Record<string, object> = {},
): void {
  const sorted = [...modules].sort((a, b) => (a.module < b.module ? -1 : 1));
  for (const { module, exports } of sorted) {
    for (const name of Object.keys(exports).sort()) {
      const value = exports[name];
      if (isHandlerRef(value) && value.export === undefined) {
        value.module = module;
        value.export = name;
      }
    }
  }
  const collection = getActiveResourceCollection();
  if (collection) collection.runtime.linked = true;
  for (const { standIns, exports } of sorted) {
    for (const [name, standIn] of Object.entries(standIns)) {
      if (!isStandIn(standIn)) continue;
      const state = standInState(standIn as object)!;
      state.value = exports[name];
      state.linked = true;
    }
  }
  for (const { standIns } of sorted) {
    for (const standIn of Object.values(standIns)) {
      if (!isStandIn(standIn)) continue;
      const state = standInState(standIn as object)!;
      for (const call of state.calls.splice(0)) call();
    }
  }

  if (!collection) return;
  for (const ref of collection.runtime.handlers) {
    if (ref.export === undefined) throw new Error(notExported(ref));
  }
  for (const { fn, info, declaredAt } of collection.runtime.functions) {
    const handlers = collection.runtime.handlers.filter(
      (ref) => ref.function === fn,
    );
    if (handlers.length === 0) {
      throw new Error(
        `The function "${info.id}" declared${declaredAt ? ` at ${declaredAt}` : ""} has no handlers. Make one with its handle, and export it.`,
      );
    }
    const byName = new Map<string, HandlerRef>();
    for (const ref of handlers) {
      const clash = byName.get(ref.export!);
      if (clash) {
        throw new Error(
          `The function "${info.id}" has two handlers named ${ref.export}, exported from ${clash.module} and ${ref.module}. Rename one of them.`,
        );
      }
      byName.set(ref.export!, ref);
    }
    info.handlers = handlers
      .map((ref) => ({
        module: ref.module!,
        export: ref.export!,
        kind: ref.kind,
      }))
      .sort((a, b) => (a.export < b.export ? -1 : 1));
    collection.graph.runtimeFunctions.push(info);
  }
  collection.graph.runtimeFunctions.sort((a, b) => (a.id < b.id ? -1 : 1));

  const readsOf = collection.runtimeReads;
  if (!readsOf) return;
  for (const { info, deliver } of collection.runtime.functions) {
    const reads = readsOf(info) ?? [];
    if (reads.length === 0) continue;
    if (!deliver) {
      throw new Error(
        `The function "${info.id}" reads ${reads[0]} from infra, but its provider can't deliver values to it.`,
      );
    }
    deliver(resolveReads(info, reads, infraModules));
  }
}

/**
 * Finds the value of each read that a function's bundle makes. A read of a
 * whole binding delivers the binding, and the reads of its paths are then
 * served from it. See `deliveredValue` for what a whole binding delivers.
 */
export function resolveReads(
  info: Pick<RuntimeFunction, "id">,
  reads: string[],
  infraModules: Record<string, object>,
): Record<string, unknown> {
  const parsed = [...new Set(reads)].sort().map((key) => ({
    key,
    ...parseOutputKey(key),
  }));
  const wholes = new Set(
    parsed.filter((read) => read.path.length === 0).map((read) => read.key),
  );
  const values: Record<string, unknown> = {};
  for (const read of parsed) {
    if (
      read.path.length > 0 &&
      wholes.has(bindingKey(read.module, read.binding))
    ) {
      continue;
    }
    const subject = `The function "${info.id}" reads ${read.key}`;
    const exports = infraModules[read.module];
    if (!exports) {
      throw new Error(
        `${subject}, but the infra phase didn't load ${read.module} as an infra module that runtime code imports. Compile the app again.`,
      );
    }
    if (!(read.binding in exports)) {
      throw new Error(
        `${subject}, but ${read.module} has no export named ${read.binding}.`,
      );
    }
    let value: unknown = (exports as Record<string, unknown>)[read.binding];
    let length = 0;
    // A path that goes on past an output value or a primitive, such as
    // `orderQueue.url.length`, reads that property in the function.
    while (length < read.path.length && !isLeaf(value)) {
      if (value === null || value === undefined) {
        value = undefined;
      } else {
        const descriptor = findProperty(Object(value), read.path[length]!);
        if (descriptor && !("value" in descriptor)) {
          const getter = outputKey(
            read.module,
            read.binding,
            read.path.slice(0, length + 1),
          );
          throw new Error(
            `${subject}, but ${getter} is a getter. Getters can have effects, so runtime code can't read through them.`,
          );
        }
        value = descriptor?.value;
      }
      length += 1;
    }
    const key = outputKey(
      read.module,
      read.binding,
      read.path.slice(0, length),
    );
    values[key] = deliveredValue(value, length === 0, subject);
  }
  return values;
}

/**
 * A binding that is data, such as a plain object of settings, is delivered
 * whole. A binding that isn't, such as a resource group, delivers only its
 * own data properties that hold output values or primitives, enumerable or
 * not: `id`, `url` and `arn` for a queue, and not its `config`. Getters are
 * not called, since they can have effects. This keeps the function's
 * environment small, and `BindingView` types the binding to match.
 */
function deliveredValue(value: unknown, binding: boolean, subject: string) {
  if (typeof value === "function") {
    throw new Error(
      `${subject}, which is a function of infra. Runtime code can't call or store infra functions; call them in the settings of lambda().`,
    );
  }
  if (value === undefined) {
    throw new Error(`${subject}, which infra leaves undefined.`);
  }
  if (isData(value)) return value;
  if (binding) {
    const data = Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(value))
        .filter(([, descriptor]) => "value" in descriptor)
        .map(([key, descriptor]) => [key, descriptor.value])
        .filter(([, entry]) => entry === null || isLeaf(entry)),
    );
    if (Object.keys(data).length > 0) return data;
  }
  throw new Error(
    `${subject}, which is not an output value or data. Runtime code can read output values, such as a queue's url, and data, such as strings, numbers and plain objects.`,
  );
}

// The descriptor of a property, own or inherited, so that a read can find
// methods and fields without calling a getter. The getter of a Lambda
// group's `policy`, for one, adds a resource.
function findProperty(
  value: object,
  key: string,
): PropertyDescriptor | undefined {
  for (let at: object | null = value; at; at = Object.getPrototypeOf(at)) {
    const descriptor = Object.getOwnPropertyDescriptor(at, key);
    if (descriptor) return descriptor;
  }
  return undefined;
}

function isLeaf(value: unknown): boolean {
  return (
    isOutputValue(value) ||
    ["string", "number", "boolean"].includes(typeof value)
  );
}

// Output values, and JSON values that may contain them.
function isData(value: unknown): boolean {
  if (value === null || isLeaf(value)) return true;
  if (Array.isArray(value)) return value.every(isData);
  if (isPlainObject(value)) {
    return Object.values(value).every(
      (entry) => entry === undefined || isData(entry),
    );
  }
  return false;
}

const lazyFunctionMark = Symbol.for("@notation/resource/LazyFunction");

// Reading these turns a value into a string, which an unknown value can't be.
const stringifyingProps = new Set<string | symbol>([
  Symbol.toPrimitive,
  "toString",
  "valueOf",
  "toJSON",
]);

// What a chain stands for once linked. `holder` is the value it was read
// from, which a call on it receives as `this`.
type ChainValue = { value: unknown; holder?: unknown };

/**
 * A stand-in's function, or a chain of property reads and calls on it, such
 * as `createOrder.function.arn` or `createOrder.function.grantInvoke()`.
 * Before linking, each read or call makes a longer chain. Config and
 * contributions that hold a chain resolve it once the runtime modules are
 * linked, through `deferredMark`. Linking makes each call, so that a call
 * made for its effect, such as `policy.contribute(...)`, still happens.
 * Reading `id`, or turning the chain into a string, fails before linking,
 * since the chain can't give a value then. After linking, the chain reads
 * through to the value it stands for.
 * @param step Finds the chain's value from its parent's, once linked. Each
 * chain runs it once.
 */
function createChain(
  state: StandInState,
  name: string,
  site: () => string | undefined,
  step: () => ChainValue,
  root = false,
): object {
  let resolved: ChainValue | undefined;
  const resolveStep = (): ChainValue => {
    if (!state.linked) {
      const where = site();
      throw new Error(
        `${name} isn't known yet: infra used it${where ? ` at ${where}` : ""} before the runtime modules were linked.`,
      );
    }
    return (resolved ??= step());
  };
  const resolve = () => resolveStep().value;
  const get = (_: object, prop: string | symbol): unknown => {
    if (prop === lazyFunctionMark) return root ? state : undefined;
    if (prop === deferredMark) return resolve;
    if (state.linked) return readLinked(resolve(), prop);
    if (prop === "then") return undefined;
    if (prop === "id" || stringifyingProps.has(prop)) {
      throw new Error(unknownUse(name, prop, at(get)));
    }
    if (typeof prop === "symbol") return undefined;
    return createChain(
      state,
      `${name}.${prop}`,
      captureCallSiteLazily(get, { skipLibraryFrames: true }),
      () => {
        const holder = resolve();
        const value =
          holder === null || holder === undefined
            ? undefined
            : Reflect.get(Object(holder), prop, holder);
        return { value, holder };
      },
    );
  };
  const callStep = (args: unknown[]) => (): ChainValue => {
    const { value, holder } = resolveStep();
    if (typeof value !== "function") {
      throw new Error(`${name} is not a function.`);
    }
    return { value: Reflect.apply(value, holder, args) };
  };
  const apply = (_: object, _this: unknown, args: unknown[]): unknown => {
    if (state.linked) return callStep(args)().value;
    const site = captureCallSiteLazily(apply, { skipLibraryFrames: true });
    const call = createChain(state, `${name}()`, site, callStep(args));
    state.calls.push(() => {
      // Resources that the call declares, such as the route that a handler's
      // `wire` adds, take infra's call site.
      const collection = getActiveResourceCollection();
      const outer = collection?.declarationSite;
      if (collection) collection.declarationSite = site;
      try {
        resolveDeferred(call);
      } catch (error) {
        const where = site();
        if (error instanceof Error && where) {
          error.message += ` Infra made the call at ${where}.`;
        }
        throw error;
      } finally {
        if (collection) collection.declarationSite = outer;
      }
    });
    return call;
  };
  const has = (_: object, prop: string | symbol): boolean => {
    if (state.linked) return prop in Object(resolve());
    return readableBeforeLinking(prop);
  };
  // A function target, so that the chain can be called.
  return new Proxy(() => {}, { get, has, apply, set: readOnly(name) });
}

// Before linking, a stand-in and a chain give a chain for each string key but
// `then`, so `in` is true for those keys.
function readableBeforeLinking(prop: string | symbol): boolean {
  return typeof prop === "string" && prop !== "then";
}

function unknownUse(name: string, prop: string | symbol, site: string) {
  const use = prop === "id" ? "read its id" : "turned it into a string";
  return `${name} isn't known yet: infra ${use} while infra was being evaluated${site}. Infra can pass it, or values read from it such as its arn, to an infra API or a resource, which resolve them once the runtime modules are linked.`;
}

function notLinked(state: StandInState): string {
  return `${state.name} from ${state.module} isn't linked yet: runtime modules are linked after infra has been evaluated.`;
}

function exportOf(state: StandInState): unknown {
  if (state.value === undefined) {
    throw new Error(
      `${state.module} has no handler or function named ${state.name}.`,
    );
  }
  return state.value;
}

function functionOf(state: StandInState): unknown {
  if (isHandlerRef(state.value)) return state.value.function;
  return exportOf(state);
}

function readLinked(target: unknown, prop: string | symbol): unknown {
  if (target === undefined || target === null) return undefined;
  const value = Reflect.get(Object(target), prop, target);
  return typeof value === "function" ? value.bind(target) : value;
}

function readOnly(name: string) {
  return () => {
    throw new Error(
      `${name} is an export of a runtime module, so infra can't set its properties.`,
    );
  };
}

function standInState(value: object): StandInState | undefined {
  try {
    return (value as any)[standInMark];
  } catch {
    return undefined;
  }
}

function lazyFunctionState(value: object): StandInState | undefined {
  try {
    return (value as any)[lazyFunctionMark];
  } catch {
    return undefined;
  }
}

function at(below: Function): string {
  const site = captureCallSite(below, { skipLibraryFrames: true });
  return site ? ` (${site})` : "";
}
