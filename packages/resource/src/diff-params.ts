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
 * A field that forces replacement. `known: false` means the desired value is
 * unknown after apply, so the field may force replacement.
 */
export type ReplaceField = { name: string; known: boolean };

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
  replaceFields: ReplaceField[];
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

  const changed: string[] = [];
  const replaceFields: ReplaceField[] = [];
  for (const [name, item] of Object.entries(schema)) {
    if (!isComparable(item)) continue;
    const unknown = isUnknownAfterApply(desiredComparable[name]);
    if (!unknown && !(name in patch)) continue;

    // A change anywhere inside the value changes the whole field.
    if (!(name in patch)) patch[name] = desiredComparable[name];
    changed.push(name);
    if (!options.canUpdate || forcesReplacement(item)) {
      replaceFields.push({ name, known: !unknown });
    }
  }

  return {
    patch,
    changed,
    replaceFields,
    diff: toDisplayDiff(detailedDiff(previousComparable, desiredComparable)),
  };
}

function isComparable(item: SchemaItem): boolean {
  return item.propertyType === "param" && !item.volatile && !item.hidden;
}

/** A different key names a different resource, so it is never updated. */
function forcesReplacement(item: SchemaItem): boolean {
  return (
    item.propertyType === "param" &&
    Boolean(item.immutable || item.primaryKey || item.secondaryKey)
  );
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
