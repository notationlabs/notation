import {
  generatedPhysicalName,
  isUnknownAfterApply,
  type BaseResource,
  type NameScope,
  type PhysicalNameRule,
} from "@notation/resource";
import { isCreatingRecord, type StateNode } from "@notation/state";

const INSTANCE_BYTES = 4;

type NameField = { field: string; rule: PhysicalNameRule };

/**
 * The `physicalName` params that the resource's config leaves out, each with
 * its rule. Config decides, not the params: at plan, the params can hold an
 * unknown value for a param that config leaves out.
 */
export function unnamedFields(resource: BaseResource): NameField[] {
  return Object.entries(resource.schema).flatMap(([field, item]) =>
    item.propertyType === "param" &&
    item.physicalName &&
    resource.config[field] === undefined
      ? [{ field, rule: item.physicalName }]
      : [],
  );
}

/**
 * Throws when `derived`, the params before deploy or plan fills in a name,
 * hold a value for one of `fields`. Config leaves these fields out, so the
 * value comes from `deriveParams`, and a generated or recorded name would
 * replace it.
 */
export function assertNamesNotDerived(
  resource: BaseResource,
  fields: NameField[],
  derived: Record<string, unknown>,
): void {
  for (const { field } of fields) {
    const value = derived[field];
    if (value === undefined || isUnknownAfterApply(value)) continue;
    throw new Error(
      `Resource "${resource.id}" (${resource.type}): deriveParams supplies "${field}", which has physicalName in the schema. Only config can supply a physicalName param. When config leaves it out, deploy generates the name.`,
    );
  }
}

/**
 * The values that the state record holds for `fields`. A "creating" record
 * counts, so a create that an earlier deploy did not finish keeps its name.
 * When the params of another record lack a field, the value comes from the
 * record's output, so the resource that exists keeps its name.
 */
export function recordedNames(
  fields: NameField[],
  stateNode: StateNode | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .map(
        ({ field }) =>
          [
            field,
            stateNode?.params[field] ??
              (isCreatingRecord(stateNode)
                ? undefined
                : stateNode?.output[field]),
          ] as const,
      )
      .filter(([, value]) => value !== undefined),
  );
}

/**
 * Makes a name with a new random instance for each of `fields`. The result
 * differs on every call, so deploy calls this inside a step.
 * @param params The resource's params, which decide a name's ending when
 * its rule has `requiredEndingWhen`.
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
  const bytes = crypto.getRandomValues(new Uint8Array(INSTANCE_BYTES));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
