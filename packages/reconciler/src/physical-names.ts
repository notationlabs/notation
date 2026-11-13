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
 * Throws when `params`, the params before deploy or plan fills in a name,
 * hold a value for one of `fields`. Deploy generates these fields, and a
 * generated or recorded name would replace the value. The config type leaves
 * them out, so the value comes from `deriveParams` or from untyped config.
 */
export function assertNamesNotSupplied(
  resource: BaseResource,
  fields: NameField[],
  params: Record<string, unknown>,
): void {
  for (const { field } of fields) {
    const value = params[field];
    if (value === undefined || isUnknownAfterApply(value)) continue;
    throw new Error(
      `Resource "${resource.id}" (${resource.type}): the params supply "${field}", which has physicalName in the schema. Deploy generates a physicalName param from the resource ID, so neither config nor deriveParams can supply it.`,
    );
  }
}

/**
 * `UNKNOWN_AFTER_APPLY` for each of the resource's `physicalName` params,
 * for a plan of a resource whose name deploy generates.
 */
export function unknownNames(resource: BaseResource): Record<string, unknown> {
  return Object.fromEntries(
    nameFields(resource).map(({ field }) => [field, UNKNOWN_AFTER_APPLY]),
  );
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
