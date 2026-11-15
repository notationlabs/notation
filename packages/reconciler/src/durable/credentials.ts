import {
  credentialMarker,
  credentialNames,
  isCredentialMarker,
  validateValues,
  type BaseResource,
  type ReplaceField,
} from "@notation/resource";
import { isCreatingRecord, type StateNode } from "@notation/state";
import { scrubError } from "@notation/utils";
import {
  credentialsToMint,
  holdCredential,
  holdsCredential,
  takesCredential,
  unheldCredentials,
} from "../credentials";
import {
  emitLifecycleEvent,
  getErrorDetails,
  toPersistedState,
} from "../operations";
import { getDependencyIds } from "../plan";
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
 * deploy reaches the resources that take it. See `credentialsToMint` for
 * when a credential needs one.
 *
 * A credential with a `rotate` operation is rotated, and its new version is
 * recorded at once, as the provider has revoked the value before it. For a
 * credential without one, the fields that force a replace of `resource` are
 * returned, and nothing is changed. A dry run rotates nothing.
 *
 * Returns the session with the record that the rotations left.
 */
export async function* mintNeededCredentials(
  step: DurableStepRunner,
  opts: DeployContext,
  session: RecordedSession,
  resource: BaseResource,
  dependsOn: string[],
): AsyncGenerator<
  any,
  { session: RecordedSession; replaceFields?: ReplaceField[] },
  any
> {
  if (credentialNames(resource.schema).length === 0) return { session };
  const consumers = opts.resources.filter(
    (candidate) =>
      candidate !== resource && takesCredential(candidate, resource),
  );
  if (consumers.length === 0) return { session };

  const needed = yield* step.run("credentials:needed", async () =>
    credentialsToMint(
      resource,
      session.node.output,
      await Promise.all(
        consumers.map(async (consumer) => ({
          resource: consumer,
          record: await opts.state.get(consumer.id),
        })),
      ),
    ),
  );
  const unrotatable = needed.filter((name) => !resource.rotate?.[name]);
  if (unrotatable.length > 0) {
    return {
      session,
      replaceFields: unrotatable.map((name) => ({ name, known: true })),
    };
  }
  if (opts.dryRun) return { session };

  let current = session;
  for (const name of needed) {
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
  return { session: current };
}

/**
 * Makes sure that deploy holds the value of every credential in `value`,
 * which is the params or the patch that an operation of `consumer` is about
 * to receive. Deploy holds none for a credential that was made in an earlier
 * deploy, or before this deploy was resumed.
 *
 * 1. A credential with a `rotate` operation is rotated, and the new version
 *    is written to the record of its resource.
 * 2. Every resource that takes the credential and that deploy has already
 *    reconciled is reconciled again, so that it is updated with the new
 *    value.
 *
 * A credential without `rotate` fails the deploy. Its record loses its
 * version first, so that the next deploy replaces its resource.
 *
 * Returns true when a credential was rotated, so the markers in `value` name
 * a version that is no longer the current one.
 */
export async function* obtainCredentials(
  step: DurableStepRunner,
  opts: DeployContext,
  consumer: BaseResource,
  value: unknown,
): AsyncGenerator<any, boolean, any> {
  const missing = unheldCredentials(value);
  for (const { $credential } of missing) {
    const { resource: id, name } = $credential;
    const producer = opts.resources.find((candidate) => candidate.id === id);
    if (!producer) {
      throw new Error(
        `${consumer.id} takes the credential ${name} of ${id}, which is not declared`,
      );
    }
    const base = step.scope(`credential:${encodeURIComponent(id)}:${name}`);
    if (!producer.rotate?.[name]) {
      yield* forgetCredential(base, opts, producer, name);
      throw new Error(
        `Cannot give ${consumer.id} the credential ${name} of ${id}: ${producer.type} returns it only when the resource is created, and deploy no longer holds the value. Deploy again, and deploy replaces ${id} to get a new one.`,
      );
    }

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
  return missing.length > 0;
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
          resource.toState(resource.output),
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
  version: string | null,
  dependsOn: string[],
): AsyncGenerator<any, RecordedSession, any> {
  const output = {
    ...session.node.output,
    [name]: credentialMarker(resource.id, name, version),
  };
  yield* session.persist(
    { ...toPersistedState(session.node, dependsOn), output },
    `credential:${version ?? `lost:${name}`}`,
  );
  return { ...session, node: { ...session.node, output, dependsOn } };
}

/**
 * Removes the credential's version from the output and the record of its
 * resource, so that the next deploy gets a new value.
 */
async function* forgetCredential(
  step: DurableStepRunner,
  opts: DeployContext,
  producer: BaseResource,
  name: string,
): AsyncGenerator<any, void, any> {
  const session = yield* openStateSession(step, opts, producer);
  producer.setOutput({
    ...producer.output,
    [name]: credentialMarker(producer.id, name, null),
  });
  if (!session.node || isCreatingRecord(session.node)) return;
  const recorded = session.node.output[name];
  if (isCredentialMarker(recorded) && recorded.$credential.version === null) {
    return;
  }
  yield* recordCredential(
    session,
    producer,
    name,
    null,
    session.node.dependsOn ?? getDependencyIds(producer),
  );
}
