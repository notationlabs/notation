import { getActiveResourceCollection } from "./resource-collection";

/** The part of a deployment's identity that scopes physical names. */
export type NameScope = {
  app: string;
  stage: string;
};

export type PhysicalNameRule = {
  /** The longest name the service accepts. */
  maxLength: number;
  /**
   * An ending the service requires, such as `.fifo`. When the name ends with
   * it, the ending stays at the end after the name is shortened.
   */
  requiredEnding?: string;
  /**
   * The name of a boolean param, such as `FifoQueue`. A generated name gets
   * `requiredEnding` when the resource's params hold `true` for it.
   */
  requiredEndingWhen?: string;
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
  const ending =
    rule.requiredEnding && name.endsWith(rule.requiredEnding)
      ? rule.requiredEnding
      : "";
  const full = scope ? `${scope.app}--${scope.stage}--${name}` : name;
  if (full.length <= rule.maxLength) return full;

  const body = full.slice(0, full.length - ending.length);
  const hash = fnv1a(full);
  const room = rule.maxLength - ending.length - HASH_LENGTH - 1;
  if (room < 1) {
    throw new Error(
      `A maximum length of ${rule.maxLength} leaves no room for a shortened name`,
    );
  }
  const prefix = body.slice(0, room).replace(/[-_.]+$/, "");
  return `${prefix}-${hash}${ending}`;
}

/**
 * Makes a generated physical name: `<app>--<stage>--<base>-<instance>`. The
 * base is the resource ID in lower case, with each run of characters other
 * than `a-z` and `0-9` replaced by one `-`. So the base holds no `--`, and
 * the name is valid where only lower-case letters, digits and hyphens are
 * allowed, if the app, the stage and the instance are.
 *
 * When the name is longer than `rule.maxLength`, the part before the
 * instance is cut short, and the instance stays whole. The name ends with
 * `rule.requiredEnding`, after the instance, when `params` hold `true` for
 * `rule.requiredEndingWhen`.
 */
export function generatedPhysicalName(
  scope: NameScope,
  resourceId: string,
  instance: string,
  rule: PhysicalNameRule,
  params: Record<string, unknown>,
): string {
  const ending =
    (rule.requiredEndingWhen &&
      params[rule.requiredEndingWhen] === true &&
      rule.requiredEnding) ||
    "";
  const base = resourceId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const room = rule.maxLength - ending.length - instance.length - 1;
  if (room < 1) {
    throw new Error(
      `A maximum length of ${rule.maxLength} leaves no room for a generated name`,
    );
  }
  const body = `${scope.app}--${scope.stage}--${base}`
    .slice(0, room)
    .replace(/-+$/, "");
  return `${body}-${instance}${ending}`;
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
