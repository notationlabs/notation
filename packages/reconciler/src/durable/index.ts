/**
 * The durable reconciler driver: `deploy` and `destroy` as generators that a
 * Yieldstar workflow composes, and the store-backed state they run against.
 *
 * Step keys are persisted: a resumed execution matches its cached work by
 * key, so changing one re-executes the work behind it. The shapes in use are:
 *
 *   notation:resource:<id>:*   per-resource reconciliation steps (deploy)
 *   notation:destroy:<id>:*    per-resource deletion steps (destroy)
 *   notation:orphans:list      the orphan sweep's one read of persisted state
 *   notation:orphans:<id>:*    orphan sweep, per persisted record
 *   *:remote:attempt:<n>       one provider call attempt
 *   *:remote:retry-delay:<n>   the wait between two attempts
 *   *:emit:<event>[:<operation>:<status>]   event delivery checkpoint
 *   notation:hold:*            deployment hold: inspect/acquire/release
 *   state:persist:<id>         conditional write of a resource record
 *   state:delete:<id>          conditional removal of one
 *
 * An <id> inside a scope is URI-encoded, so the `:` delimiter is unambiguous.
 * The state: keys are store-handle keys and so are not scope-prefixed: a
 * store outlives the scope that opened it, which is why they carry the
 * resource id themselves.
 *
 * Store names are persisted identifiers too, and carry the "notation/"
 * prefix so they cannot collide with an application's stores on a shared
 * store client. This driver owns:
 *
 *   notation/resource-state    one record per live resource
 *   notation/deployment-hold   one hold per deployment
 *
 * @notation/core's durable runtime persists one more name under the same
 * prefix, notation/execution-binding (see its durable-runtime module).
 */
export { deploy } from "./deploy";
export { destroy } from "./destroy";
export {
  takeOverDeploymentHold,
  type DeploymentHoldTakeover,
} from "./deployment-hold";
export { DurableStateBackend } from "./state-backend";
export { deploymentHoldStore, resourceStateStore } from "./stores";
export {
  type DurableDeployOptions,
  type DurableWorkflowOptions,
} from "./types";
export type { DurableStep } from "./yieldstar";
