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
 * Makes the physical name of a resource: `<app>-<stage>-<name>`, or `name`
 * when there is no scope.
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
  const full = scope ? `${scope.app}-${scope.stage}-${name}` : name;
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
