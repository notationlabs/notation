/**
 * The durable reconciler driver: `deploy` and `destroy` as generators that a
 * Yieldstar workflow composes, and the store-backed state they run against.
 *
 * Step keys are persisted: a resumed execution matches its cached work by
 * key, so changing one re-executes the work behind it. The shapes in use are:
 *
 *   notation:deploy:<id>:*     per-resource reconciliation steps
 *   notation:destroy:<id>:*    per-resource deletion steps
 *   notation:orphans:list      the orphan sweep's one read of persisted state
 *   notation:orphans:<id>:*    orphan sweep, per persisted record
 *   *:create:remote:effect:<n> one create attempt, as a step.effect
 *   *:remote:attempt:<n>       one read, update or delete attempt
 *   *:remote:retry-delay:<n>   the wait between two attempts
 *   *:emit:<event>[:<operation>:<status>]   event delivery checkpoint
 *   notation:hold:*            deployment hold: inspect/acquire/release
 *   state:persist:<id>         conditional create or update of a resource
 *                              record
 *   state:delete:<id>          conditional removal of one
 *   state:create:<id>          unconditional write of a record removed
 *                              earlier in the same execution
 *   *:replace:delete:*         replacement, first half: the delete
 *   *:replace:create:*         replacement, second half: the create, ending
 *                              in state:create
 *
 * Opening a store has no step key.
 *
 * Effect IDs are persisted in the same way. A create attempt's effect ID is
 * notation:create:<execution id>:<resource id>:<n>, with both IDs
 * URI-encoded. The resource receives it as the attempt's token.
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
 */
import "./errors";
export { deploy } from "./deploy";
export { destroy } from "./destroy";
export {
  clearDeploymentHold,
  type DeploymentHoldClearance,
} from "./deployment-hold";
export { DurableStateBackend } from "./state-backend";
export { deploymentHoldStore, resourceStateStore } from "./stores";
export {
  type DurableDeployOptions,
  type DurableWorkflowOptions,
} from "./types";
export type { DurableStep } from "./yieldstar";
