import { ID_RULE, isNameSafe } from "@notation/utils";

export {
  assertId,
  ID_MAX_LENGTH,
  isNameSafe,
  type IdOption,
  type NameSafe,
} from "@notation/utils";

/**
 * Throws when `name`, the override of a JWT authorizer's AWS name, is set
 * and is not name-safe.
 */
export function assertName(caller: string, name: unknown): void {
  if (name === undefined) return;
  if (!isNameSafe(name)) {
    throw new Error(
      `Invalid ${caller} name ${JSON.stringify(name)}: use ${ID_RULE}.`,
    );
  }
}

/**
 * Makes the id of a resource from a type prefix and the ids of the
 * declarations that it belongs to, such as `lambda:orders:role`. Ids can't
 * hold `:`, so two different lists never make the same resource id. Only the
 * last part, such as the path of a route, may hold `:`.
 */
export function resourceId(type: string, ...ids: string[]): string {
  return [type, ...ids].join(":");
}

/**
 * The base of a resource's generated AWS name: the resource id without the
 * type prefix that `resourceId` adds, such as `orders:role`.
 */
export function nameBase(resourceId: string): string {
  return resourceId.slice(resourceId.indexOf(":") + 1);
}
