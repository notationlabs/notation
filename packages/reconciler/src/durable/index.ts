/**
 * The durable reconciler driver: `deploy` and `destroy` as generators that a
 * @notation/durable workflow composes, and the store-backed state they run against.
 *
 * Step keys are persisted: a resumed execution matches its cached work by
 * key, so changing one re-executes the work behind it. The shapes in use are:
 *
 *   notation:providers         @notation/core's list of provider
 *                              packages to load
 *   notation:providers:<package>:emit   warning for a package that
 *                              fails to load
 *   notation:validate          deploy's check of known params, before
 *                              any change
 *   notation:recorded-outputs  the outputs that `~state` refs read, from
 *                              state at the start of the deploy
 *   notation:deploy:<id>:*     per-resource reconciliation steps
 *   notation:deploy:<id>:placeholder:*   the first pass over a cycle, for
 *                              a placeholder
 *   notation:deploy:<id>:settle:<n>:*    pass <n> after the first over a
 *                              cycle
 *   notation:destroy:<id>:*    per-resource deletion steps
 *   notation:orphans:list      the orphan sweep's one read of persisted state
 *   notation:orphans:<id>:*    orphan sweep, per persisted record
 *   notation:retired:<id>:*    the sweep's delete of the retired instances
 *                              of a record in code
 *   *:retired:<n>:*            the delete of a record's retired instance
 *                              <n>, oldest first
 *   *:physical-names           the names that deploy generates for a
 *                              resource, or for its replacement
 *   *:create:remote:effect:<n> one create attempt, as a step.effect
 *   *:remote:attempt:<n>       one read, update or delete attempt
 *   *:remote:retry-delay:<n>   the wait between two attempts
 *   *:emit:<event>[:<operation>:<status>]   event delivery checkpoint
 *   notation:hold:*            deployment hold: inspect/acquire/release
 *   state:persist:<id>         conditional create or update of a resource
 *                              record
 *   state:persist:<id>:creating   conditional write of the "creating"
 *                              record, before a create is attempted
 *   state:persist:<id>:taken-over conditional write of the record of a
 *                              resource that create took over
 *   state:persist:<id>:restored   conditional write of the record that a
 *                              failed create started from or that the
 *                              replaced resource had, or removal of the
 *                              "creating" record if there is none
 *   state:persist:<id>:retired:<n>   conditional write that removes
 *                              retired instance <n> from the record
 *   state:delete:<id>          conditional removal of one
 *   state:<write>:<id>:settle:<n>        a write in pass <n> over a cycle
 *   state:<write>:<id>[:<stage>]:after-takeover   a write that follows a
 *                              takeover, with one :after-takeover for each
 *                              takeover it follows
 *   state:delete:<id>:replace:<replaced id>   the removal of a dependent
 *                              that blocks the delete of <replaced id>
 *   *:replace:delete:*         delete-first replacement, first half: the
 *                              delete
 *   *:replace:create:*         replacement: the create. In a delete-first
 *                              replacement, a read of the removed record
 *                              comes first
 *   *:create:find              the find, before a create, of a resource
 *                              that already exists
 *   *:create:existing          the find of a resource that the provider
 *                              reported as already existing
 *   *:delete:find              the find of the resource of a "creating"
 *                              record, before a delete
 *   *:create:takeover:read:*   the read of a resource that create took over
 *   *:taken-over:*             the decision and change that follow a
 *                              takeover
 *
 * Opening a store has no step key.
 *
 * Effect IDs are persisted in the same way. A create attempt's effect ID is
 * notation:create:<execution id>:<resource id>:<n>, with both IDs
 * URI-encoded. A create that follows a takeover in the same execution adds
 * /taken-over to the execution ID of the create that took the resource over,
 * so a create after a second takeover uses
 * <execution id>/taken-over/taken-over.
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
export type { DurableStep } from "./sdk";
