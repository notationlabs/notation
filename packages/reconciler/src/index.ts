export type ResourceApi = typeof import("@notation/resource");
export type StateApi = typeof import("@notation/state");
export type DeepObjectDiffApi = typeof import("deep-object-diff");
export type YieldstarApi = typeof import("yieldstar");

export * from "./resource-registry";
export * from "./operations";

export interface ReconcilerInput<TCurrent = unknown, TDesired = unknown> {
  current: TCurrent;
  desired: TDesired;
}

export interface ReconcilerResult<TCurrent = unknown, TDesired = unknown> {
  input: ReconcilerInput<TCurrent, TDesired>;
  hasChanges: boolean;
}

export function reconcile<TCurrent, TDesired>(
  input: ReconcilerInput<TCurrent, TDesired>,
): ReconcilerResult<TCurrent, TDesired> {
  return {
    input,
    hasChanges: false,
  };
}
