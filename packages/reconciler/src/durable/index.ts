/**
 * Step keys are a public contract: they are what a resumed execution matches
 * its cached work against, so changing one re-executes the work behind it.
 * The shapes in use are:
 *
 *   notation:resource:<id>:*        per-resource reconciliation steps
 *   notation:destroy:<id>:*         per-resource deletion steps
 *   notation:orphans:<id>:*         orphan sweep, per persisted record
 *   *:remote:attempt:<n>            one provider call attempt
 *   *:remote:retry-delay:<n>        the wait between two attempts
 *   emit:<event>[:<operation>:<status>]   event delivery checkpoint
 *   notation:coordination:*         deployment hold: inspect/acquire/release
 *   state:persist:<id>              conditional write of a resource record
 *   state:delete:<id>               conditional removal of one
 *
 * The state: keys are store-handle keys and so are not scope-prefixed: a
 * store outlives the scope that opened it, which is why they carry the
 * resource id themselves.
 */
export { deploy } from "./deploy";
export { destroy } from "./destroy";
export {
  takeOverDeploymentHold,
  type DeploymentHoldTakeover,
} from "./coordination";
export { DurableStateBackend } from "./state-backend";
export {
  deploymentCoordinationStore,
  resourceStateStore,
  type CoordinationState,
  type StoredResourceState,
} from "./stores";
export {
  type DurableDeployOptions,
  type DurableDestroyOptions,
  type DurableOperationOptions,
} from "./types";
export type { DurableStep } from "./yieldstar";
