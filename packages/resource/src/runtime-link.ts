import { captureCallSite } from "./contributions";
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

export type RuntimeRegistry = {
  handlers: HandlerRef[];
  functions: Array<{ fn: object; info: RuntimeFunction; declaredAt?: string }>;
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
}

/**
 * Makes a handler reference for `fn`, and registers it so that linking fails
 * if no runtime module exports it. `below` is the provider function that the
 * user's code called, so the call site names the user's `handle` call.
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
 */
export function declareRuntimeFunction(
  fn: object,
  info: Omit<RuntimeFunction, "handlers">,
  below: Function,
): void {
  const collection = getActiveResourceCollection();
  if (!collection) return;
  const declaredAt = captureCallSite(below, { skipLibraryFrames: true });
  collection.runtime.functions.push({
    fn,
    info: { ...info, handlers: [] },
    declaredAt,
  });
}

type StandInState = {
  module: string;
  name: string;
  linked: boolean;
  value: unknown;
};

/**
 * What infra sees in place of an export of a runtime module, while the
 * runtime module has not run. After linking, it reads through to the export.
 * Before, reading it fails, except for `function`, which is a lazy proxy of
 * the export's function.
 * @param module The runtime module, relative to the project root.
 */
export function createStandIn(
  module: string,
  name: string,
): RuntimeRef<any, unknown, unknown> {
  const state: StandInState = { module, name, linked: false, value: undefined };
  let lazyFunction: object | undefined;
  const get = (_: object, prop: string | symbol): unknown => {
    if (prop === standInMark) return state;
    if (prop === "then") return undefined;
    if (state.linked) {
      if (prop === "function") return functionOf(state);
      return readLinked(state.value, prop);
    }
    if (prop === "function") {
      return (lazyFunction ??= createLazyFunction(state));
    }
    throw new Error(
      `${name} isn't known yet: infra read ${String(prop)} on it while infra was being evaluated${at(get)}. Pass it to an infra API such as route() or consume(), which wire it once evaluation ends.`,
    );
  };
  return new Proxy({}, { get, set: readOnly(name) }) as RuntimeRef<
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
  if (typeof value !== "object" || value === null) return value;
  const state = standInState(value) ?? lazyFunctionState(value);
  if (!state) return value;
  if (!state.linked) {
    throw new Error(
      `${state.name} from ${state.module} isn't linked yet: runtime modules are linked after infra has been evaluated.`,
    );
  }
  return lazyFunctionState(value) ? functionOf(state) : state.value;
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
 */
export function linkRuntimeModules(modules: RuntimeModuleLink[]): void {
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
  for (const { standIns, exports } of sorted) {
    for (const [name, standIn] of Object.entries(standIns)) {
      if (!isStandIn(standIn)) continue;
      const state = standInState(standIn as object)!;
      state.value = exports[name];
      state.linked = true;
    }
  }

  const collection = getActiveResourceCollection();
  if (!collection) return;
  for (const ref of collection.runtime.handlers) {
    if (ref.export === undefined) {
      throw new Error(
        `The ${ref.kind} handler made${ref.declaredAt ? ` at ${ref.declaredAt}` : ""} isn't exported from a runtime module. Export it, so that infra can wire it and its function can dispatch to it.`,
      );
    }
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
}

const lazyFunctionMark = Symbol.for("@notation/resource/LazyFunction");

function createLazyFunction(state: StandInState): object {
  const get = (_: object, prop: string | symbol): unknown => {
    if (prop === lazyFunctionMark) return state;
    if (prop === "then") return undefined;
    if (state.linked) return readLinked(functionOf(state), prop);
    throw new Error(
      `${state.name}.function isn't known yet: infra used it as a value while infra was being evaluated${at(get)}. Infra can pass it to an infra API, but not read it.`,
    );
  };
  return new Proxy({}, { get, set: readOnly(`${state.name}.function`) });
}

function functionOf(state: StandInState): unknown {
  if (isHandlerRef(state.value)) return state.value.function;
  if (state.value === undefined) {
    throw new Error(
      `${state.module} has no handler or function named ${state.name}.`,
    );
  }
  return state.value;
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
