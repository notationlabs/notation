import {
  containsUnknownAfterApply,
  type RejectChange,
} from "@notation/resource";

/**
 * A `rejectChange` that refuses every replace with `message`, and allows
 * every other change. A changed param that forces the replace is refused
 * first by its `rejectReplace`. At plan, an unknown param may not force a
 * replace, and deploy checks again with the real value.
 */
export function refuseReplace(message: string): RejectChange<any> {
  return (_previous, desired, context) => {
    if (!context.replace) return undefined;
    if (!context.requested && containsUnknownAfterApply(desired)) {
      return undefined;
    }
    return message;
  };
}
