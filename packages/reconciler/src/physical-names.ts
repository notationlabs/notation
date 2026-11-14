import {
  GENERATED_INSTANCE_LENGTH,
  UNKNOWN_AFTER_APPLY,
  generatedPhysicalName,
  isUnknownAfterApply,
  type BaseResource,
  type NameScope,
  type PhysicalNameRule,
} from "@notation/resource";
import type { StateNode } from "@notation/state";
import type { ReplaceOrder } from "./events";

type NameField = { field: string; rule: PhysicalNameRule };

/** The resource's `physicalName` params, each with its rule. */
export function nameFields(resource: BaseResource): NameField[] {
  return Object.entries(resource.schema).flatMap(([field, item]) =>
    item.propertyType === "param" && item.physicalName
      ? [{ field, rule: item.physicalName }]
      : [],
  );
}

/**
 * A replace creates first when the resource has a `physicalName` param:
 * deploy generates a new name for the replacement, so the replacement can
 * exist beside the resource it replaces. It also creates first when the
 * class sets `replaceCreatesFirst`, because each replace changes the key.
 * Any other replacement would collide with the resource, so it deletes
 * first.
 */
export function replaceOrder(resource: BaseResource): ReplaceOrder {
  return resource.replaceCreatesFirst || nameFields(resource).length > 0
    ? "create-first"
    : "delete-first";
}

/**
 * Throws when `params`, the params before deploy or plan fills in a name,
 * hold a value for one of `fields` whose rule does not have `suppliable`.
 * Deploy generates these fields, and a generated or recorded name would
 * replace the value. The config type leaves them out, so the value comes
 * from `deriveParams` or from untyped config.
 */
export function assertNamesNotSupplied(
  resource: BaseResource,
  fields: NameField[],
  params: Record<string, unknown>,
): void {
  for (const { field, rule } of fields) {
    if (rule.suppliable) continue;
    const value = params[field];
    if (value === undefined || isUnknownAfterApply(value)) continue;
    throw new Error(
      `Resource "${resource.id}" (${resource.type}): the params supply "${field}", which has physicalName in the schema. Deploy generates a physicalName param from the resource ID, so neither config nor deriveParams can supply it.`,
    );
  }
}

/**
 * The values that `params`, the params before deploy or plan fills in a
 * name, hold for those of `fields` whose rule has `suppliable`. At plan, a
 * value can be `UNKNOWN_AFTER_APPLY`.
 */
export function suppliedNames(
  fields: NameField[],
  params: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter(({ rule }) => rule.suppliable)
      .map(({ field }) => [field, params[field]] as const)
      .filter(([, value]) => value !== undefined),
  );
}

/**
 * The names a plan shows for a resource whose name deploy has not yet
 * chosen: the supplied value for each suppliable `physicalName` param that
 * `params` supply, and `UNKNOWN_AFTER_APPLY` for each other one.
 * @param params The params before plan fills in a name.
 */
export function unknownNames(
  resource: BaseResource,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const fields = nameFields(resource);
  return {
    ...Object.fromEntries(
      fields.map(({ field }) => [field, UNKNOWN_AFTER_APPLY]),
    ),
    ...suppliedNames(fields, params),
  };
}

/**
 * The values that the state record holds for `fields`. A "creating" record
 * counts, so a create that an earlier deploy did not finish keeps its name.
 */
export function recordedNames(
  fields: NameField[],
  stateNode: StateNode | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .map(({ field }) => [field, stateNode?.params[field]] as const)
      .filter(([, value]) => value !== undefined),
  );
}

/**
 * Makes a name with a new random instance for each of `fields`. The result
 * differs on every call, so deploy calls this inside a step.
 * @param params The resource's params, which decide a name's ending when
 * its rule has `ending`.
 */
export function generateNames(
  resource: BaseResource,
  fields: NameField[],
  scope: NameScope,
  params: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    fields.map(({ field, rule }) => [
      field,
      generatedPhysicalName(scope, resource.id, randomInstance(), rule, params),
    ]),
  );
}

function randomInstance(): string {
  const bytes = crypto.getRandomValues(
    new Uint8Array(GENERATED_INSTANCE_LENGTH / 2),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
