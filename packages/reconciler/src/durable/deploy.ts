import {
  credentialNames,
  findCredentialMarkers,
  isCredentialSource,
  type BaseResource,
} from "@notation/resource";
import { isCreatingRecord, type StateNode } from "@notation/state";
import { findCredentialConsumers } from "../credentials";
import { isCycle, orderDeployUnits } from "../cycles";
import { assertDependenciesPresent } from "../dependency-graph";
import { sweepSteps, sweptRecords } from "../orphan-sweep";
import {
  assertOrphanDeleteAllowed,
  decideAction,
  keepsResource,
} from "../plan";
import { loadUnit, planKnownParams } from "../planner";
import { readRecordedOutputs } from "../recorded-outputs";
import { assertOverrides, findReplaceOverride } from "../overrides";
import { workflowRegistry, type ResourceRegistry } from "../resource-registry";
import {
  mintedCredentials,
  rotatesForCreate,
  throwIfUnobtainable,
  type UnobtainableCredential,
} from "../unobtainable-credential";
import { reconcileCycle } from "./cycle";
import { withDeploymentHold } from "./deployment-hold";
import { reconcileResource, sweepOrphans } from "./reconcile";
import { scopeStep } from "./step";
import type { DeployContext, DurableDeployOptions } from "./types";
import type { DurableStep } from "./sdk";

export async function* deploy(
  step: DurableStep,
  opts: DurableDeployOptions,
): AsyncGenerator<any, void, any> {
  assertDependenciesPresent(opts.resources);
  // A step, so that a resumed execution does not run every resource's
  // deriveParams again.
  yield* step.run("notation:validate", async () => {
    // Before `decideAction`, so that a wrong ID or hash fails with its own
    // message, not a class's refusal of the replace. Outside the hold, this
    // can fail with "not in state" while another deploy is in a delete-first
    // replace of the target. That is accepted.
    await checkOverrides(opts);
    await validateKnownParams(opts);
    return null;
  });
  yield* withDeploymentHold(step, opts, async function* () {
    // Again inside the hold, so that a deploy that waited for another one
    // checks the hashes against the records that the other one left.
    if (opts.overrides) {
      yield* step.run("notation:overrides", async () => {
        await checkOverrides(opts);
        return null;
      });
    }
    // Read once, inside the hold, so that every `~state` ref reads the
    // records as they were at the start of the deploy, and a resumed deploy
    // reads the same ones.
    const deployOpts: DeployContext = {
      ...opts,
      recordedOutputs: yield* step.run("notation:recorded-outputs", () =>
        readRecordedOutputs(opts.resources, opts.state),
      ),
      reconciled: new Set(),
    };
    // Reconcile in dependency order, so a resource only runs once its
    // dependencies have converged.
    for (const unit of orderDeployUnits(opts.resources)) {
      if (isCycle(unit)) {
        yield* reconcileCycle(step, unit, deployOpts);
        continue;
      }
      const [resource] = unit.members;
      yield* reconcileResource(
        scopeStep(step, `notation:deploy:${encodeURIComponent(resource!.id)}`),
        resource!,
        deployOpts,
      );
    }

    yield* sweepOrphans(step, deployOpts);
  });
}

async function checkOverrides(opts: DurableDeployOptions): Promise<void> {
  if (!opts.overrides) return;
  assertOverrides(opts.overrides, {
    resources: opts.resources,
    records: await opts.state.values(),
    deploymentId: opts.state.deploymentId,
    point: "deploy",
  });
}

/**
 * Checks every value deploy knows before it changes anything, as the planner
 * does, and runs each `rejectChange`, also for each orphan that the sweep
 * deletes. A value that comes from an output that does not exist yet is
 * checked later, just before the operation of the resource that holds it.
 *
 * A required output missing from the record of a resource with no `read` is
 * not checked here, on purpose. It is checked in `reconcileResource`, so a
 * deploy can fail there after it has deployed the resources before it. A
 * check here would need deploy's decision for the resource, which depends on
 * drift reads and on the outputs of dependencies that deploy creates again.
 * Neither is known yet, so the check would fail deploys that succeed. Plan
 * still checks before any change.
 *
 * A credential without `rotate` that deploy needs and cannot get is checked
 * here as plan checks it, from the decisions without drift. As in plan, the
 * error lists every such credential.
 */
async function validateKnownParams(opts: DurableDeployOptions): Promise<void> {
  const recordedOutputs = await readRecordedOutputs(opts.resources, opts.state);
  const records = new Map(
    (await opts.state.values()).map((node) => [node.id, node]),
  );
  // The credentials that get a new value before deploy reaches the resources
  // that take them, by the ID of their resource.
  const renewed = new Map<string, readonly string[]>();
  const unobtainable: UnobtainableCredential[] = [];
  for (const unit of orderDeployUnits(opts.resources)) {
    for (const resource of await loadUnit(unit, opts.state)) {
      const { stateNode, params } = await planKnownParams(
        resource,
        opts.state,
        "deploy",
        recordedOutputs,
      );
      // A source is never replaced, so no change to it is checked.
      if (isCredentialSource(resource)) continue;
      const decision = stateNode
        ? decideAction({
            resource,
            stateNode,
            params,
            replaceOverride: findReplaceOverride(opts.overrides, resource.id),
          }).decision
        : "create";
      renewed.set(
        resource.id,
        stateNode && !isCreatingRecord(stateNode) && keepsResource(decision)
          ? await mintedCredentials({
              producer: resource,
              record: stateNode,
              consumers: findCredentialConsumers(resource, opts.resources).map(
                (consumer) => ({
                  resource: consumer,
                  record: records.get(consumer.id),
                }),
              ),
              recordedOutputs,
              overrides: opts.overrides,
              deploymentId: opts.state.deploymentId,
              unobtainable,
            })
          : credentialNames(resource.schema),
      );
      if (!keepsResource(decision)) {
        findCredentialsForCreate(
          opts,
          resource,
          params,
          records,
          renewed,
          unobtainable,
        );
      }
    }
  }
  throwIfUnobtainable(unobtainable, opts.overrides);
  const registry = workflowRegistry(opts);
  for (const stateNode of orphansDeployDeletes(
    await opts.state.values(),
    new Set(opts.resources.map((resource) => resource.id)),
    registry,
  )) {
    assertOrphanDeleteAllowed(registry, stateNode);
  }
}

/**
 * Adds to `unobtainable` each credential that `resource` takes, and that
 * deploy cannot get when it creates `resource` again. See
 * `rotatesForCreate`.
 */
function findCredentialsForCreate(
  opts: DurableDeployOptions,
  resource: BaseResource,
  params: Record<string, unknown>,
  records: ReadonlyMap<string, StateNode>,
  renewed: Map<string, readonly string[]>,
  unobtainable: UnobtainableCredential[],
): void {
  for (const { $credential } of findCredentialMarkers(params)) {
    const { resource: id, name } = $credential;
    const producer = opts.resources.find((candidate) => candidate.id === id);
    if (!producer || isCredentialSource(producer)) continue;
    // As in plan, a producer that comes later in a cycle is skipped.
    if (!renewed.has(id) || renewed.get(id)!.includes(name)) continue;
    const rotates = rotatesForCreate({
      consumer: resource,
      producer,
      name,
      record: records.get(id),
      overrides: opts.overrides,
      deploymentId: opts.state.deploymentId,
      unobtainable,
    });
    if (rotates) renewed.set(id, [...(renewed.get(id) ?? []), name]);
  }
}

/** The orphans that deploy's sweep deletes, in delete order. */
function orphansDeployDeletes(
  records: StateNode[],
  inCode: ReadonlySet<string>,
  registry: ResourceRegistry,
): StateNode[] {
  const { swept, edgesById } = sweptRecords(records, inCode);
  return sweepSteps(swept, registry, edgesById, new Set())
    .filter((step) => step.Resource && step.orphan)
    .map((step) => step.node);
}
