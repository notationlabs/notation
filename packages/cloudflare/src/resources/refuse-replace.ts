import type { RejectChange } from "@notation/resource";

/**
 * A `rejectChange` that refuses a replace that the user asked for with
 * `--replace`, with `message`, and allows every other change. A replace that
 * a changed param forces is refused by the param's `rejectReplace`.
 */
export function refuseReplace(message: string): RejectChange<any> {
  return (_previous, _desired, context) =>
    context.requested ? message : undefined;
}
