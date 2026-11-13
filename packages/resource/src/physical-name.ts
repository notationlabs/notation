import { getActiveResourceCollection } from "./resource-collection";
import { isPlainObject } from "./output-ref";

/** The part of a deployment's identity that scopes physical names. */
export type NameScope = {
  app: string;
  stage: string;
};

export type PhysicalNameRule = {
  /** The longest name the service accepts. */
  maxLength: number;
  /**
   * Returns the ending that the service requires on a generated name, such
   * as `.fifo`, or `""` for none. It takes the resource's params. Without
   * it, a generated name has no ending.
   */
  ending?: (params: Record<string, unknown>) => string;
  /**
   * Maps the resource ID to the base of a generated name. Without it, the
   * base is the whole resource ID.
   */
  base?: (resourceId: string) => string;
};

const HASH_LENGTH = 8;

// 32-bit FNV-1a, as 8 hex characters. This package does not depend on Node,
// so it cannot use node:crypto.
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(HASH_LENGTH, "0");
}

/**
 * Makes the physical name of a resource: `<app>--<stage>--<name>`, or `name`
 * when there is no scope. App and stage names cannot contain `--`, so the
 * first `--` ends the app and the second ends the stage. Two scopes therefore
 * never produce the same name.
 *
 * When the result is longer than `rule.maxLength`, it is cut short and ends
 * in `-` and the 8 hex characters of the FNV-1a hash of the full name, so
 * shortened names stay unique and the same on every deploy.
 */
export function physicalName(
  scope: NameScope | undefined,
  name: string,
  rule: PhysicalNameRule,
): string {
  const full = scope ? `${scope.app}--${scope.stage}--${name}` : name;
  if (full.length <= rule.maxLength) return full;

  const hash = fnv1a(full);
  const room = rule.maxLength - HASH_LENGTH - 1;
  if (room < 1) {
    throw new Error(
      `A maximum length of ${rule.maxLength} leaves no room for a shortened name`,
    );
  }
  const prefix = full.slice(0, room).replace(/[-_.]+$/, "");
  return `${prefix}-${hash}`;
}

/**
 * Makes a generated physical name: `<app>--<stage>--<base>-<instance>`, the
 * result of `generatedNameBody` followed by `-<instance>` and the result of
 * `rule.ending` for `params`.
 */
export function generatedPhysicalName(
  scope: NameScope,
  resourceId: string,
  instance: string,
  rule: PhysicalNameRule,
  params: Record<string, unknown>,
): string {
  const ending = rule.ending?.(params) ?? "";
  const body = generatedNameBody(
    scope,
    resourceId,
    rule,
    instance.length + 1 + ending.length,
  );
  return `${body}-${instance}${ending}`;
}

/**
 * Makes the part of a generated physical name before `-<instance>`:
 * `<app>--<stage>--<base>`. The base is the result of `rule.base` for the
 * resource ID, or the resource ID without `rule.base`. It is put in lower
 * case, with each run of characters other than `a-z` and `0-9` replaced by
 * one `-`. So the base holds no `--`, and the name is valid where only
 * lower-case letters, digits and hyphens are allowed, if the app, the stage
 * and the instance are.
 *
 * The result is cut short to leave room for `suffixLength` characters
 * within `rule.maxLength`.
 * @param suffixLength The length of `-<instance>` and the ending.
 */
export function generatedNameBody(
  scope: NameScope,
  resourceId: string,
  rule: PhysicalNameRule,
  suffixLength: number,
): string {
  const base = (rule.base ? rule.base(resourceId) : resourceId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const room = rule.maxLength - suffixLength;
  if (room < 1) {
    throw new Error(
      `A maximum length of ${rule.maxLength} leaves no room for a generated name`,
    );
  }
  return `${scope.app}--${scope.stage}--${base}`
    .slice(0, room)
    .replace(/-+$/, "");
}

/**
 * Makes the physical name of a resource declared during the active
 * collection, scoped by the collection's app and stage. It is an engine
 * mechanism for resource packages, not user-facing API.
 */
export function scopedPhysicalName(
  name: string,
  rule: PhysicalNameRule,
): string {
  return physicalName(getActiveResourceCollection()?.scope, name, rule);
}

/**
 * Stands in the params for a ref from a resource to its own `physicalName`
 * param, until deploy or plan fills in the name. It is a plain object, so
 * the step that records the params can hold it.
 */
export type OwnPhysicalName = { "~physicalName": string };

export function ownPhysicalName(field: string): OwnPhysicalName {
  return { "~physicalName": field };
}

export function isOwnPhysicalName(value: unknown): value is OwnPhysicalName {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 1 &&
    typeof value["~physicalName"] === "string"
  );
}

/**
 * Copies `params`, setting each name in `names` and replacing each
 * `OwnPhysicalName` with the name of its field.
 */
export function fillPhysicalNames(
  params: Record<string, unknown>,
  names: Record<string, unknown>,
): Record<string, unknown> {
  const fill = (value: unknown): unknown => {
    if (isOwnPhysicalName(value)) {
      const field = value["~physicalName"];
      if (!(field in names)) {
        throw new Error(`No name was given for ${field}`);
      }
      return names[field];
    }
    if (Array.isArray(value)) return value.map(fill);
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, fill(entry)]),
      );
    }
    return value;
  };
  return { ...(fill(params) as Record<string, unknown>), ...names };
}
