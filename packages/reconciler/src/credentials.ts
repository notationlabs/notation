import { randomUUID } from "node:crypto";
import {
  credentialMarker,
  credentialNames,
  findCredentialMarkers,
  forEachOutputRef,
  isCredentialMarker,
  mapCredentialMarkers,
  validateValues,
  type BaseResource,
  type CredentialMarker,
} from "@notation/resource";
import { isCreatingRecord, type StateNode } from "@notation/state";
import { recordSecretValue } from "@notation/utils";
import type { ResourceAction } from "./plan";

// The values of credentials, by version. They are kept here only, for the
// life of the process, so a resumed deploy starts with none. A process runs
// one deploy: `credentialsToMint` reads records and not this map, so a
// second deploy in the process would rotate a credential whose value is
// still held.
const held = new Map<string, unknown>();

// The versions whose values an operation of each resource has received, in
// this process. An operation that is replayed from the journal receives none.
const given = new WeakMap<BaseResource, Set<string>>();

/**
 * Keeps a credential's value in memory, and returns the version that names
 * it. Every string in the value is removed from error messages from then on.
 */
export function holdCredential(value: unknown): string {
  recordSecretStrings(value);
  const version = randomUUID();
  held.set(version, value);
  return version;
}

function recordSecretStrings(value: unknown): void {
  if (typeof value === "string") recordSecretValue(value);
  else if (value && typeof value === "object") {
    Object.values(value).forEach(recordSecretStrings);
  }
}

export function holdsCredential(version: string | null): boolean {
  return version !== null && held.has(version);
}

/** Forgets every value. For tests. */
export function clearHeldCredentials(): void {
  held.clear();
}

/**
 * `output` with a marker for each credential of the resource that it lacks.
 * The marker has no version, so deploy gets a new value before a resource
 * takes the credential.
 */
export function withCredentialMarkers(
  resource: BaseResource,
  output: Record<string, unknown>,
): Record<string, unknown> {
  const markers: Record<string, unknown> = {};
  for (const name of credentialNames(resource.schema)) {
    if (!isCredentialMarker(output[name])) {
      markers[name] = credentialMarker(resource.id, name, null);
    }
  }
  return { ...output, ...markers };
}

/**
 * Sets the resource's output from a record or a read, with a marker for each
 * credential. See `withCredentialMarkers`.
 */
export function setRecordedOutput(
  resource: BaseResource,
  output: Record<string, unknown>,
): void {
  resource.setOutput(withCredentialMarkers(resource, output));
}

/** `value` without the properties that are credentials of the resource. */
export function withoutCredentials<T extends {} | null | void>(
  resource: BaseResource,
  value: T,
): T {
  if (!value) return value;
  const rest: Record<string, unknown> = { ...value };
  for (const name of credentialNames(resource.schema)) delete rest[name];
  return rest as T;
}

/**
 * The resource's output as `update`, `delete` and `rotate` receive it in
 * `state`: without its own credentials, and with `undefined` in place of
 * each credential that it takes.
 */
export function operationState(resource: BaseResource): {} {
  return mapCredentialMarkers(
    resource.toState(withoutCredentials(resource, resource.output)),
    () => undefined,
  ) as {};
}

/** The credential markers in the resource's output. */
export function credentialOutputs(
  resource: BaseResource,
): Record<string, unknown> {
  const output = (resource.output ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    credentialNames(resource.schema)
      .filter((name) => output[name] !== undefined)
      .map((name) => [name, output[name]]),
  );
}

/**
 * Takes the credentials out of a create result, and holds their values.
 * Returns the rest of the result, and the version of each credential. A
 * credential that create did not return gets no version. Nor does one whose
 * value fails its validator, which `invalid` names.
 */
export async function holdCreated(
  resource: BaseResource,
  result: {} | void,
): Promise<{
  key: {} | void;
  credentials?: Record<string, string>;
  invalid?: string[];
}> {
  const names = credentialNames(resource.schema);
  if (names.length === 0 || !result) return { key: result };
  const key: Record<string, unknown> = { ...result };
  const credentials: Record<string, string> = {};
  const invalid: string[] = [];
  for (const name of names) {
    const value = key[name];
    delete key[name];
    if (value === undefined) continue;
    try {
      await validateValues(resource, { [name]: value }, "create");
    } catch {
      invalid.push(name);
      continue;
    }
    credentials[name] = holdCredential(value);
  }
  return { key, credentials, ...(invalid.length > 0 ? { invalid } : {}) };
}

/**
 * Copies a value, with the held value in place of each credential marker.
 * Throws for a marker whose value is not held. `taker` is the resource whose
 * operation receives the copy.
 */
export function revealCredentials<T>(value: T, taker: BaseResource): T {
  return mapCredentialMarkers(value, (marker) => {
    const { resource, name, version } = marker.$credential;
    if (!holdsCredential(version)) {
      throw new Error(
        `Deploy holds no value for the credential ${name} of ${resource}`,
      );
    }
    if (!given.has(taker)) given.set(taker, new Set());
    given.get(taker)!.add(version!);
    return held.get(version!);
  }) as T;
}

/**
 * Whether an operation of `taker` has received, in this process, the value
 * of every credential marker in `value`.
 */
export function wasGivenCredentials(
  taker: BaseResource,
  value: unknown,
): boolean {
  return findCredentialMarkers(value).every(
    ({ $credential }) =>
      given.get(taker)?.has($credential.version ?? "") ?? false,
  );
}

/**
 * Copies a value, with no version in each credential marker, as in the
 * record of a resource that has not taken the credential's current value.
 */
export function staleCredentialMarkers<T>(value: T): T {
  return mapCredentialMarkers(value, ({ $credential }) =>
    credentialMarker($credential.resource, $credential.name, null),
  ) as T;
}

/**
 * Throws when a `hidden` param of the resource takes a credential. State
 * does not record a hidden param, so every deploy would find that the
 * resource has not taken the credential's value, and rotate it.
 */
export function assertNoHiddenCredential(resource: BaseResource): void {
  for (const [field, value] of Object.entries(resource.config ?? {})) {
    const item = resource.schema[field];
    if (item?.propertyType !== "param" || !item.hidden) continue;
    forEachOutputRef(value, (ref) => {
      const name = String(ref.path[0]);
      if (ref.resource.schema[name]?.propertyType !== "credential") return;
      throw new Error(
        `${resource.id} cannot take the credential ${name} of ${ref.resource.id} in ${field}: ${field} is a hidden param, which state does not record`,
      );
    });
  }
}

/**
 * `revealCredentials` for the params of an update. A param that holds a
 * credential whose value is not held is left out.
 */
export function revealHeldCredentials(
  params: Record<string, unknown>,
  taker: BaseResource,
): Record<string, unknown> {
  const revealed: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(params)) {
    if (unheldCredentials(value).length > 0) continue;
    revealed[field] = revealCredentials(value, taker);
  }
  return revealed;
}

/** The credential markers in a value whose values are not held. */
export function unheldCredentials(value: unknown): CredentialMarker[] {
  const seen = new Set<string>();
  return findCredentialMarkers(value).filter((marker) => {
    const { resource, name, version } = marker.$credential;
    const id = JSON.stringify([resource, name]);
    if (holdsCredential(version) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Copies a value, with each credential marker replaced by the marker that
 * its resource's output holds now.
 */
export function currentCredentialMarkers<T>(
  value: T,
  resources: readonly BaseResource[],
): T {
  return mapCredentialMarkers(value, (marker) => {
    const { resource: id, name } = marker.$credential;
    const resource = resources.find((candidate) => candidate.id === id);
    const output = resource?.output as Record<string, unknown> | null;
    const current = output?.[name];
    return isCredentialMarker(current) ? current : marker;
  }) as T;
}

/** Whether the resource's config or contributions hold the credential. */
export function takesCredential(
  resource: BaseResource,
  producer: BaseResource,
  name?: string,
): boolean {
  return resource
    .getOutputRefs()
    .some(
      (ref) =>
        ref.resource === producer &&
        producer.schema[ref.path[0]!]?.propertyType === "credential" &&
        (name === undefined || ref.path[0] === name),
    );
}

/**
 * The credentials of `producer` that need a new value: a resource takes the
 * credential, and one of these holds:
 *
 * 1. The output in the producer's record has no version for it.
 * 2. A resource that takes it has no record, or a "creating" record.
 * 3. The record of a resource that takes it holds another version, because
 *    an earlier deploy failed before it updated the resource.
 */
export function credentialsToMint(
  producer: BaseResource,
  output: Record<string, unknown>,
  consumers: readonly { resource: BaseResource; record?: StateNode }[],
): string[] {
  return credentialNames(producer.schema).filter((name) => {
    const taking = consumers.filter(({ resource }) =>
      takesCredential(resource, producer, name),
    );
    if (taking.length === 0) return false;
    const marker = output[name];
    const version = isCredentialMarker(marker)
      ? marker.$credential.version
      : null;
    if (version === null) return true;
    return taking.some(
      ({ record }) =>
        !record ||
        isCreatingRecord(record) ||
        !findCredentialMarkers(record.params).some(
          ({ $credential: held }) =>
            held.resource === producer.id &&
            held.name === name &&
            held.version === version,
        ),
    );
  });
}

/** The resources that take a credential of `producer`. */
export function credentialConsumers(
  producer: BaseResource,
  resources: readonly BaseResource[],
): BaseResource[] {
  if (credentialNames(producer.schema).length === 0) return [];
  return resources.filter(
    (candidate) =>
      candidate !== producer && takesCredential(candidate, producer),
  );
}

/**
 * How deploy gets a new value for each of the credentials `names` of
 * `producer`. It rotates them when each has a `rotate` operation. Otherwise
 * it replaces the producer, and `replace` is the action for that.
 */
export function mintAction(
  producer: BaseResource,
  names: string[],
): {
  rotates: string[];
  replace?: Extract<ResourceAction, { decision: "replace" }>;
} {
  const unrotatable = names.filter((name) => !producer.rotate?.[name]);
  if (unrotatable.length === 0) return { rotates: names };
  return {
    rotates: [],
    replace: {
      decision: "replace",
      patch: {},
      diff: { added: {}, deleted: {}, updated: {} },
      replaceFields: unrotatable.map((name) => ({
        name,
        known: true,
        credential: true,
      })),
    },
  };
}
