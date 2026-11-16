import {
  credentialMarker,
  isCredentialSource,
  validateValues,
  type BaseResource,
  type CredentialMarker,
} from "@notation/resource";
import { isCreatingRecord, type StateNode } from "@notation/state";
import { scrubError } from "@notation/utils";
import {
  findCredentialConsumers,
  getCredentialsToMint,
  getCredentialVersion,
  deferUnobtainable,
  holdCredential,
  holdsCredential,
  getOperationState,
  recordSecretStrings,
  takesCredential,
  findUnheldCredentials,
} from "../credentials";
import {
  emitLifecycleEvent,
  getErrorDetails,
  toPersistedState,
} from "../operations";
import { getDependencyIds } from "../plan";
import type { CredentialTarget } from "../overrides";
import {
  UnobtainableCredentialError,
  unobtainableCredential,
} from "../unobtainable-credential";
import { loadSourceCredential } from "./source";
import {
  openStateSession,
  reconcileResource,
  type ResourceStateSession,
} from "./reconcile";
import { durableEmitter, type DurableStepRunner } from "./step";
import type { DeployContext } from "./types";

type RecordedSession = Extract<ResourceStateSession, { node: StateNode }>;

/**
 * Gets a new value for each credential of `resource` that needs one, before
 * deploy reaches the resources that take it:
 *
 * 1. Each credential that `--credential` names takes the value of its
 *    variable. Deploy treats the value as new, so every resource that takes
 *    the credential is updated.
 * 2. Each other credential that needs a value is rotated. See
 *    `getCredentialsToMint` for when a credential needs one. A credential
 *    without `rotate` fails the deploy.
 *
 * The new version is recorded at once, as a rotation revokes the value
 * before it. A dry run changes nothing.
 *
 * Returns the session with the record that these writes left.
 */
export async function* mintNeededCredentials(
  step: DurableStepRunner,
  opts: DeployContext,
  session: RecordedSession,
  resource: BaseResource,
  dependsOn: string[],
): AsyncGenerator<any, RecordedSession, any> {
  let current = session;
  const passed = (opts.overrides?.credential ?? []).filter(
    (target) => target.id === resource.id,
  );
  // A cycle reconciles a resource more than once, and each flag sets the
  // value once.
  if (!opts.dryRun && !opts.reconciled.has(resource)) {
    for (const target of passed) {
      const scope = step.scope(`credential-passed:${target.name}`);
      const version = yield* applyPassedCredential(
        scope,
        opts,
        resource,
        target,
      );
      current = yield* recordCredential(
        current,
        resource,
        target.name,
        version,
        dependsOn,
      );
    }
  }

  const consumers = findCredentialConsumers(resource, opts.resources);
  if (consumers.length === 0) return current;
  const output = current.node.output;
  const needed = yield* step.run("credentials:needed", async () =>
    (
      await getCredentialsToMint(
        resource,
        output,
        await Promise.all(
          consumers.map(async (consumer) => ({
            resource: consumer,
            record: await opts.state.get(consumer.id),
          })),
        ),
        opts.recordedOutputs,
      )
    ).map(({ name, consumer }) => ({ name, consumer: consumer.id })),
  );
  for (const { name, consumer } of needed) {
    if (passed.some((target) => target.name === name)) continue;
    if (!resource.rotate?.[name]) {
      throw new UnobtainableCredentialError(
        [
          unobtainableCredential({
            consumer: consumers.find((candidate) => candidate.id === consumer)!,
            producer: resource,
            name,
            record: current.node,
            version: getCredentialVersion(resource, name),
            deploymentId: opts.state.deploymentId,
          }),
        ],
        opts.overrides,
      );
    }
    if (opts.dryRun) continue;
    const scope = step.scope(`credential:${name}`);
    const version = yield* rotateStep(scope, opts, resource, name);
    current = yield* recordCredential(
      current,
      resource,
      name,
      version,
      dependsOn,
    );
  }
  return current;
}

/**
 * Makes sure that deploy holds the value of every credential in `markers`,
 * the credentials that an operation of `consumer` is about to receive. Deploy holds none for a credential that was made in an earlier
 * deploy, or before this deploy was resumed.
 *
 * 1. A source's credential is loaded with `loadCredential`. Its version
 *    stays the same, so no other resource is updated.
 * 2. A credential with a `rotate` operation is rotated, and the new version
 *    is written to the record of its resource. Every resource that takes
 *    the credential and that deploy has already reconciled is reconciled
 *    again, so that it is updated with the new value.
 *
 * Any other credential fails the operation that receives it, when the
 * operation runs. See `deferUnobtainable`.
 *
 * Returns true when a credential was rotated, so `markers` name
 * a version that is no longer the current one.
 */
export async function* obtainCredentials(
  step: DurableStepRunner,
  opts: DeployContext,
  consumer: BaseResource,
  markers: readonly CredentialMarker[],
): AsyncGenerator<any, boolean, any> {
  let rotated = false;
  for (const { $credential } of findUnheldCredentials(markers)) {
    const { resource: id, name } = $credential;
    const producer = opts.resources.find((candidate) => candidate.id === id);
    if (!producer) {
      throw new Error(
        `${consumer.id} takes the credential ${name} of ${id}, which is not declared`,
      );
    }
    const base = step.scope(`credential:${encodeURIComponent(id)}:${name}`);
    if (isCredentialSource(producer)) {
      yield* loadSourceCredential(base, opts, producer);
      continue;
    }
    const version = getCredentialVersion(producer, name);
    if (!producer.rotate?.[name]) {
      // The operation throws this error when it reveals the credential. An
      // operation replayed from the journal reveals nothing, so a resumed
      // deploy does not fail for a value that it no longer needs.
      const session = yield* openStateSession(base, opts, producer);
      deferUnobtainable(
        consumer,
        id,
        name,
        new UnobtainableCredentialError(
          [
            unobtainableCredential({
              consumer,
              producer,
              name,
              record: session.node,
              version,
              deploymentId: opts.state.deploymentId,
            }),
          ],
          opts.overrides,
        ),
      );
      continue;
    }

    rotated = true;
    // A resumed deploy finds the version of an earlier attempt in the
    // journal, without its value, so it rotates again.
    for (let attempt = 0; ; attempt += 1) {
      const scope = base.scope(String(attempt));
      const version = yield* rotateStep(scope, opts, producer, name);
      if (!holdsCredential(version)) continue;
      const session = yield* openStateSession(scope, opts, producer);
      if (session.node && !isCreatingRecord(session.node)) {
        yield* recordCredential(
          session,
          producer,
          name,
          version,
          session.node.dependsOn ?? getDependencyIds(producer),
        );
      }
      for (const sibling of opts.reconciled) {
        if (sibling === consumer || !takesCredential(sibling, producer, name)) {
          continue;
        }
        yield* reconcileResource(
          scope.scope(
            `refresh:${encodeURIComponent(sibling.id)}`,
            `credential:${version}`,
          ),
          sibling,
          // The first reconcile of the resource read it for drift.
          { ...opts, driftDetection: false },
          { quietNoop: true },
        );
      }
      break;
    }
  }
  return rotated;
}

/**
 * Reads the value of a `--credential` from its variable, checks it, and
 * holds it under `version`.
 */
async function holdPassedCredential(
  resource: BaseResource,
  target: CredentialTarget,
  version?: string,
): Promise<string> {
  const value = process.env[target.variable];
  if (!value) {
    throw new Error(
      `--credential ${target.id}.${target.name} reads ${target.variable}, which is not set.`,
    );
  }
  recordSecretStrings(value);
  await validateValues(resource, { [target.name]: value }, "deploy");
  return holdCredential(value, version);
}

/**
 * Holds the value of a `--credential` under a new version, and sets the
 * version in the resource's output. The step records the version only.
 */
async function* applyPassedCredential(
  step: DurableStepRunner,
  opts: DeployContext,
  resource: BaseResource,
  target: CredentialTarget,
): AsyncGenerator<any, string, any> {
  const { name } = target;
  const event = { resource, emit: durableEmitter(step, opts.emit) };
  yield* emitLifecycleEvent(event, "rotate", "start", {
    credential: name,
    reason: "passed",
  });
  let version: string;
  try {
    version = yield* step.run("passed", async () =>
      holdPassedCredential(resource, target),
    );
  } catch (error) {
    yield* emitLifecycleEvent(event, "rotate", "error", {
      credential: name,
      reason: "passed",
      ...getErrorDetails(error),
    });
    throw error;
  }
  if (!holdsCredential(version)) {
    await holdPassedCredential(resource, target, version);
  }
  resource.setOutput({
    ...resource.output,
    [name]: credentialMarker(resource.id, name, version),
  });
  yield* emitLifecycleEvent(event, "rotate", "success", {
    credential: name,
    reason: "passed",
  });
  return version;
}

/**
 * Calls the `rotate` operation of the credential, holds the value it
 * returns, and sets the new version in the resource's output. The step
 * records the version only.
 */
async function* rotateStep(
  step: DurableStepRunner,
  opts: DeployContext,
  resource: BaseResource,
  name: string,
): AsyncGenerator<any, string, any> {
  const event = { resource, emit: durableEmitter(step, opts.emit) };
  yield* emitLifecycleEvent(event, "rotate", "start", { credential: name });
  let version: string;
  try {
    version = yield* step.run("rotate", async () => {
      try {
        const value = await resource.rotate![name]!(
          resource.key,
          getOperationState(resource),
        );
        await validateValues(resource, { [name]: value }, "rotate");
        return holdCredential(value);
      } catch (error) {
        throw scrubError(error);
      }
    });
  } catch (error) {
    yield* emitLifecycleEvent(event, "rotate", "error", {
      credential: name,
      ...getErrorDetails(error),
    });
    throw error;
  }
  resource.setOutput({
    ...resource.output,
    [name]: credentialMarker(resource.id, name, version),
  });
  yield* emitLifecycleEvent(event, "rotate", "success", { credential: name });
  return version;
}

/** Writes the credential's version to the record of its resource. */
async function* recordCredential(
  session: RecordedSession,
  resource: BaseResource,
  name: string,
  version: string,
  dependsOn: string[],
): AsyncGenerator<any, RecordedSession, any> {
  const output = {
    ...session.node.output,
    [name]: credentialMarker(resource.id, name, version),
  };
  yield* session.persist(
    { ...toPersistedState(session.node, dependsOn), output },
    `credential:${version}`,
  );
  return { ...session, node: { ...session.node, output, dependsOn } };
}
