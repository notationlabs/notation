import { createHash } from "node:crypto";
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

/**
 * Makes the physical name of a resource: `<app>-<stage>-<name>`, or `name`
 * when there is no scope.
 *
 * When the result is longer than `rule.maxLength`, it is cut short and ends
 * in `-` and the first 8 hex characters of the SHA-256 of the full name, so
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
  const hash = createHash("sha256")
    .update(full)
    .digest("hex")
    .slice(0, HASH_LENGTH);
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
