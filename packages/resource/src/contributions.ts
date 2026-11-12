import { sortedJson } from "@notation/utils";
import type { DeepPartial } from "./types";
import type { BaseResource } from "./resource";
import {
  containsOutputRef,
  isPlainObject,
  toCanonicalOutputRefs,
} from "./output-ref";

/** What a collected param's `collect` receives besides the items. */
export type CollectContext = {
  resourceId: string;
  param: string;
  /** The contributor of each item, in the same order as the items. */
  contributors: string[];
};

/**
 * A contribution computed from the outputs of `deps`. At deploy it receives
 * the deps. At plan it receives views of the deps; see `createPlanViews`.
 */
export type ContributionFunction<Deps, Values> = (context: {
  deps: Deps;
}) => Values;

export type ContributedValues = {
  values: Record<string, unknown>;
  contributor: string;
};

export type Contribution =
  | ContributedValues
  | {
      compute: ContributionFunction<any, Record<string, unknown>>;
      deps: Record<string, BaseResource>;
      contributor: string;
    };

export class ContributionConflictError extends Error {
  constructor(
    readonly resourceId: string,
    readonly path: string,
    readonly contributors: [string, string],
    values: [unknown, unknown],
  ) {
    super(
      `Conflicting contributions to ${resourceId}: ${contributors[0]} and ${contributors[1]} both set ${path}, to ${display(values[0])} and ${display(values[1])}`,
    );
    this.name = "ContributionConflictError";
  }
}

function display(value: unknown): string {
  return sortedJson.encode(toCanonicalOutputRefs(value));
}

/**
 * Returns `file:line` of the code that called `below`, relative to the
 * working directory when it is inside it.
 *
 * With `skipLibraryFrames`, frames in node_modules and in the source or build
 * of the @notation packages are skipped, so a resource that a library helper
 * declares is reported at the user's code that called the helper. When every
 * frame is skipped, the first is returned.
 */
export function captureCallSite(
  below: Function,
  opts: { skipLibraryFrames?: boolean } = {},
): string | undefined {
  return captureCallSiteLazily(below, opts)();
}

/**
 * Captures the stack now, and returns a function that finds the call site in
 * it on its first call. V8 formats a captured stack only when it is first
 * read, and formatting is the costly part, most of all with source maps on.
 */
export function captureCallSiteLazily(
  below: Function,
  opts: { skipLibraryFrames?: boolean } = {},
): () => string | undefined {
  const holder: { stack?: string } = {};
  const ErrorClass = Error as {
    captureStackTrace?: Function;
    stackTraceLimit?: number;
  };
  const capture = ErrorClass.captureStackTrace;
  if (!capture) return () => undefined;
  const limit = ErrorClass.stackTraceLimit;
  // Library frames can fill the default limit of 10 before the user's frame.
  if (opts.skipLibraryFrames) ErrorClass.stackTraceLimit = 100;
  try {
    capture(holder, below);
  } finally {
    ErrorClass.stackTraceLimit = limit;
  }

  let found = false;
  let callSite: string | undefined;
  return () => {
    if (!found) {
      callSite = findCallSite(holder.stack, opts.skipLibraryFrames);
      found = true;
    }
    return callSite;
  };
}

function findCallSite(
  stack: string | undefined,
  skipLibraryFrames: boolean | undefined,
): string | undefined {
  const sites = (stack?.split("\n").slice(1) ?? [])
    .map(parseFrame)
    .filter((site) => site !== undefined);
  const site = skipLibraryFrames
    ? (sites.find((site) => !isLibraryFile(site.file)) ?? sites[0])
    : sites[0];
  if (!site) return undefined;

  let file = site.file;
  const cwd = (
    globalThis as { process?: { cwd?: () => string } }
  ).process?.cwd?.();
  if (cwd && file.startsWith(`${cwd}/`)) file = file.slice(cwd.length + 1);
  return `${file}:${site.line}`;
}

function parseFrame(frame: string): { file: string; line: string } | undefined {
  const match = frame.match(/\(?([^\s()]+):(\d+):\d+\)?\s*$/);
  if (!match) return undefined;
  let file = match[1]!;
  if (file.startsWith("file://")) {
    file = decodeURIComponent(file.slice("file://".length));
  }
  return { file, line: match[2]! };
}

// The directory that holds the @notation packages: node_modules/@notation
// when installed, or the repository's packages directory when linked from a
// workspace. The first frame of a stack captured here gives the path of this
// file, which is expected at <packages>/resource/{src,dist}/<file>. At any
// other path the directory is unset, and only node_modules frames are
// skipped, because a directory derived from another layout could hold the
// user's code.
const notationPackagesDir = (() => {
  const holder: { stack?: string } = {};
  (Error as { captureStackTrace?: Function }).captureStackTrace?.(holder);
  const file = parseFrame(holder.stack?.split("\n")[1] ?? "")?.file;
  const match = file?.match(/^(.+)\/resource\/(?:src|dist)\/[^/]+$/);
  return match?.[1];
})();

function isLibraryFile(file: string): boolean {
  if (file.includes("/node_modules/") || file.startsWith("node:")) return true;
  if (!notationPackagesDir || !file.startsWith(`${notationPackagesDir}/`)) {
    return false;
  }
  const inPackage = file.slice(notationPackagesDir.length + 1);
  return /^[^/]+\/(src|dist)\//.test(inPackage);
}

/**
 * Sorts contributions by their content, so the order does not depend on the
 * order code ran in, and moving code to another file changes nothing.
 */
export function sortContributions<T extends { contributor: string }>(
  items: T[],
  valueOf: (item: T) => unknown,
): T[] {
  const keyed = items.map((item) => ({
    item,
    key: sortedJson.encode(toCanonicalOutputRefs(valueOf(item))),
  }));
  keyed.sort(
    (a, b) =>
      compare(a.key, b.key) || compare(a.item.contributor, b.item.contributor),
  );
  return keyed.map(({ item }) => item);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cloneMaps(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const cloned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    cloned[key] = cloneMaps(entry);
  }
  return cloned;
}

/**
 * A `collect` rule that merges maps key by key. Two items that set one key
 * to different values conflict, and the error names both contributors. Any
 * value other than a map, including an array, is set whole.
 *
 * A value that holds an output ref is not known yet, so it cannot be
 * compared: the merge keeps it, and a conflict with it is found at deploy,
 * when the output refs have been filled in.
 */
export function mergeContributions<T>(
  items: DeepPartial<T>[],
  context: CollectContext,
): T {
  const root: Record<string, unknown> = {};
  const owners = new Map<string, string>();

  const ownerOf = (path: string[]): string => {
    for (let length = path.length; length > 0; length -= 1) {
      const owner = owners.get(JSON.stringify(path.slice(0, length)));
      if (owner) return owner;
    }
    return "an earlier contributor";
  };

  const mergeInto = (
    target: Record<string, unknown>,
    source: Record<string, unknown>,
    contributor: string,
    path: string[],
  ) => {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      const entryPath = [...path, key];
      const existing = target[key];
      if (existing === undefined) {
        target[key] = cloneMaps(value);
        owners.set(JSON.stringify(entryPath), contributor);
        continue;
      }
      if (isPlainObject(existing) && isPlainObject(value)) {
        mergeInto(existing, value, contributor, entryPath);
        continue;
      }
      if (display(existing) === display(value)) continue;
      if (containsOutputRef(value)) {
        target[key] = value;
        continue;
      }
      if (containsOutputRef(existing)) continue;
      throw new ContributionConflictError(
        context.resourceId,
        entryPath.join("."),
        [ownerOf(entryPath), contributor],
        [existing, value],
      );
    }
  };

  items.forEach((item, index) => {
    mergeInto(
      root,
      { [context.param]: item },
      context.contributors[index] ?? "an unnamed contributor",
      [],
    );
  });
  return root[context.param] as T;
}
