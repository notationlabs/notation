import {
  generatedPhysicalName,
  type BaseResource,
  type NameScope,
} from "@notation/resource";
import type { StateNode } from "@notation/state";

const INSTANCE_BYTES = 4;

/** The `physicalName` params of the resource that `params` leave out. */
export function unnamedFields(
  resource: BaseResource,
  params: Record<string, unknown>,
): string[] {
  return Object.entries(resource.schema)
    .filter(
      ([field, item]) =>
        item.propertyType === "param" &&
        item.physicalName &&
        params[field] === undefined,
    )
    .map(([field]) => field);
}

/**
 * The values that the state record holds for `fields`. A "creating" record
 * counts, so a create that an earlier deploy did not finish keeps its name.
 */
export function recordedNames(
  fields: string[],
  stateNode: StateNode | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .map((field) => [field, stateNode?.params[field]] as const)
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
  fields: string[],
  scope: NameScope | undefined,
  params: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => {
      const item = resource.schema[field]!;
      const rule =
        item.propertyType === "param" ? item.physicalName : undefined;
      return [
        field,
        generatedPhysicalName(
          scope,
          resource.id,
          randomInstance(),
          rule!,
          params,
        ),
      ];
    }),
  );
}

function randomInstance(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(INSTANCE_BYTES));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
