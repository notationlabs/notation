import { detailedDiff, diff } from "deep-object-diff";
import type { Schema, SchemaItem } from "./resource.schema";

/**
 * Stands in for a param whose value is known only once a dependency has been
 * applied. Compared structurally, so it survives a JSON round trip.
 */
export const UNKNOWN_AFTER_APPLY = { $unknown: "after-apply" } as const;

export type UnknownAfterApply = typeof UNKNOWN_AFTER_APPLY;

export function isUnknownAfterApply(
  value: unknown,
): value is UnknownAfterApply {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>).$unknown === UNKNOWN_AFTER_APPLY.$unknown
  );
}

/**
 * Whether the value is unknown after apply, or holds a value that is, at any
 * depth. A plan marks a value unknown at its own path, so the rest of a map
 * stays visible.
 */
export function containsUnknownAfterApply(value: unknown): boolean {
  if (isUnknownAfterApply(value)) return true;
  if (Array.isArray(value)) return value.some(containsUnknownAfterApply);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsUnknownAfterApply);
  }
  return false;
}

/**
 * A field that forces replacement. `known: false` means the desired value, or
 * part of it, is unknown after apply, so the field may force replacement.
 */
export type ParamReplaceField = {
  name: string;
  known: boolean;
  requested?: never;
};

/**
 * What forces a replacement: a field, or the user's request with
 * `--replace`, which names no field.
 */
export type ReplaceField =
  ParamReplaceField | { requested: true; known: true; name?: never };

export type ParamsDiffDisplay = {
  added: Record<string, unknown>;
  deleted: Record<string, unknown>;
  updated: Record<string, unknown>;
};

export type ParamsDiff = {
  /** Changed comparable params only. */
  patch: Record<string, unknown>;
  /** Names of changed fields. */
  changed: string[];
  /** Fields that force replacement. */
  replaceFields: ParamReplaceField[];
  /** For plan display. */
  diff: ParamsDiffDisplay;
};

/**
 * Keeps the params that take part in a comparison: `param` items that are
 * neither volatile nor hidden. An `undefined` value counts as absent: state
 * is stored as JSON, which drops it, so keeping it would make an unset
 * optional param look changed on every deploy.
 */
export function toComparableParams(
  schema: Schema,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const comparable: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(schema)) {
    if (!isComparable(item)) continue;
    if (values[key] !== undefined) comparable[key] = values[key];
  }
  return comparable;
}

/**
 * Compares previous and desired params field by field, and reads the schema
 * to decide which changes no update can apply: a change to an immutable or
 * key param, or any change at all when the resource cannot update. Pure: it
 * reads nothing but its arguments, so any engine planning a Notation resource
 * reaches the same answer as the reconciler.
 */
export function diffParams(
  schema: Schema,
  previous: Record<string, unknown>,
  desired: Record<string, unknown>,
  options: { canUpdate: boolean },
): ParamsDiff {
  const previousComparable = toComparableParams(schema, previous);
  const desiredComparable = toComparableParams(schema, desired);
  const patch = diff(previousComparable, desiredComparable) as Record<
    string,
    unknown
  >;
  const kindChanges = findKindChanges(previousComparable, desiredComparable);
  for (const path of kindChanges)
    patch[path[0]!] ??= desiredComparable[path[0]!];

  const changed: string[] = [];
  const replaceFields: ParamReplaceField[] = [];
  for (const [name, item] of Object.entries(schema)) {
    if (!isComparable(item)) continue;
    const unknown = containsUnknownAfterApply(desiredComparable[name]);
    if (!unknown && !(name in patch)) continue;

    // A change anywhere inside the value changes the whole field, and the
    // patch carries it whole: cloud APIs replace a field, so a nested diff
    // can't be sent as it is.
    patch[name] = desiredComparable[name];
    changed.push(name);
    if (!options.canUpdate || forcesReplacement(item)) {
      replaceFields.push({ name, known: !unknown });
    }
  }

  return {
    patch,
    changed,
    replaceFields,
    diff: withKindChanges(
      toDisplayDiff(detailedDiff(previousComparable, desiredComparable)),
      kindChanges,
      desiredComparable,
    ),
  };
}

type Path = readonly string[];

/**
 * The paths at which one side holds an array and the other holds an object
 * that is not an array. `deep-object-diff` compares both by their keys, so it
 * finds no change between `{}` and `[]`, or between `{ "0": "x" }` and
 * `["x"]`. The search stops at the first such path on each branch.
 */
function findKindChanges(
  previous: unknown,
  desired: unknown,
  path: Path = [],
  found: Path[] = [],
): Path[] {
  if (!isObject(previous) || !isObject(desired)) return found;
  if (Array.isArray(previous) !== Array.isArray(desired)) {
    found.push(path);
    return found;
  }
  for (const [key, entry] of Object.entries(desired)) {
    if (key in previous) {
      findKindChanges(
        (previous as Record<string, unknown>)[key],
        entry,
        [...path, key],
        found,
      );
    }
  }
  return found;
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/**
 * Shows each kind change as an update to the desired value at its path, in
 * place of the added and deleted keys that `detailedDiff` found under it.
 */
function withKindChanges(
  display: ParamsDiffDisplay,
  kindChanges: Path[],
  desired: Record<string, unknown>,
): ParamsDiffDisplay {
  for (const path of kindChanges) {
    removeAt(display.added, path);
    removeAt(display.deleted, path);
    removeAt(display.updated, path);
    setAt(display.updated, path, toJsonSafe(valueAt(desired, path)));
  }
  return display;
}

function valueAt(root: unknown, path: Path): unknown {
  let value = root;
  for (const key of path) value = (value as Record<string, unknown>)[key];
  return value;
}

function setAt(root: Record<string, unknown>, path: Path, value: unknown) {
  let target = root;
  for (const key of path.slice(0, -1)) {
    if (!isObject(target[key])) target[key] = {};
    target = target[key] as Record<string, unknown>;
  }
  target[path[path.length - 1]!] = value;
}

// Deletes the entry at `path`, and then each parent that is left empty.
function removeAt(root: Record<string, unknown>, path: Path): void {
  const parents: Record<string, unknown>[] = [];
  let target = root;
  for (const key of path.slice(0, -1)) {
    if (!isObject(target[key])) return;
    parents.push(target);
    target = target[key] as Record<string, unknown>;
  }
  delete target[path[path.length - 1]!];
  for (let index = parents.length - 1; index >= 0; index--) {
    const key = path[index]!;
    const child = parents[index]![key] as Record<string, unknown>;
    if (Object.keys(child).length > 0) return;
    delete parents[index]![key];
  }
}

function isComparable(item: SchemaItem): boolean {
  return item.propertyType === "param" && !item.volatile && !item.hidden;
}

/** A different key names a different resource, so it is never updated. */
export function forcesReplacement(item: SchemaItem): boolean {
  return (
    item.propertyType === "param" &&
    Boolean(item.immutable || item.primaryKey || item.secondaryKey)
  );
}

/** The top-level keys whose values differ between `before` and `after`, sorted. */
export function changedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set(Object.keys(diff(before, after)));
  for (const path of findKindChanges(before, after)) keys.add(path[0]!);
  return [...keys].sort();
}

function toDisplayDiff(diffResult: {
  added: object;
  deleted: object;
  updated: object;
}): ParamsDiffDisplay {
  return {
    added: toJsonSafe(diffResult.added) as Record<string, unknown>,
    deleted: toJsonSafe(diffResult.deleted) as Record<string, unknown>,
    updated: toJsonSafe(diffResult.updated) as Record<string, unknown>,
  };
}

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      safe[key] = toJsonSafe(entry);
    }
    return safe;
  }
  return value;
}
