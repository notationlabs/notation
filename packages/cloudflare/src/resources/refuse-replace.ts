import type { RejectChange } from "@notation/resource";

/**
 * A `rejectChange` that refuses a replace requested with `--replace`, and
 * allows every other change. A replace that a changed param forces goes
 * through the param's `rejectReplace` instead.
 */
export function refuseReplace(message: string): RejectChange<any> {
  return (_previous, _desired, context) =>
    context.requested ? message : undefined;
}
