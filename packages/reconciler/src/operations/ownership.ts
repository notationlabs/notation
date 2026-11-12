import {
  ResourceNotFoundError,
  type BaseResource,
  type DurableObject,
} from "@notation/resource";

/**
 * The proof that one of Notation's creates made an existing resource. `key`
 * is what `find` returned, and is null when `find` returned nothing or the
 * class has no `find`. `executionId` names the execution whose token `find`
 * matched, and is null when the proof is the resource's parent.
 */
export type OwnershipProof = {
  key: DurableObject | null;
  executionId: string | null;
};

/**
 * The create token of one execution's create of a resource. Every attempt
 * of that create receives it. The attempt's effect ID adds the attempt
 * number to it.
 */
export function createToken(executionId: string, resourceId: string): string {
  return [
    "notation:create",
    encodeURIComponent(executionId),
    encodeURIComponent(resourceId),
  ].join(":");
}

/**
 * Proves that one of Notation's creates made the resource that has the key
 * in `resourceParams`, or returns null:
 * 1. With `ownership: "token"`, it calls `find` with the create token of each
 *    execution in `executionIds`, and returns the first match.
 * 2. With `ownership: "parent"`, any resource with the key is Notation's. A
 *    class with `find` finds the resource's key. `find` receives the token
 *    of the last execution in `executionIds`.
 * 3. Otherwise nothing proves it.
 */
export async function proveOwnership(
  resource: BaseResource,
  resourceParams: Record<string, unknown>,
  executionIds: string[],
): Promise<OwnershipProof | null> {
  const { find } = resource;
  if (resource.ownership === "parent") {
    if (!find) return { key: null, executionId: null };
    const executionId = executionIds[executionIds.length - 1] ?? "";
    const key = await findKey(resource, () =>
      find(resourceParams, createToken(executionId, resource.id)),
    );
    return key === undefined ? null : { key, executionId: null };
  }
  if (resource.ownership !== "token" || !find) return null;
  for (const executionId of executionIds) {
    const key = await findKey(resource, () =>
      find(resourceParams, createToken(executionId, resource.id)),
    );
    if (key !== undefined) return { key, executionId };
  }
  return null;
}

/** Returns what `find` returned, or undefined when it found nothing. */
async function findKey(
  resource: BaseResource,
  find: () => Promise<{} | void>,
): Promise<DurableObject | null | undefined> {
  try {
    const key = await find();
    return key ? resource.toResult(key) : null;
  } catch (error) {
    if (ResourceNotFoundError.is(error)) return undefined;
    throw error;
  }
}

export function hasComputedPrimaryKey(resource: BaseResource) {
  return Object.values(resource.schema).some(
    (item) => item.propertyType === "computed" && item.primaryKey,
  );
}
