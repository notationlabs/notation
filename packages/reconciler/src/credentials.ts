import { randomUUID } from "node:crypto";
import {
  credentialMarker,
  credentialNames,
  findCredentialMarkers,
  isCredentialMarker,
  mapCredentialMarkers,
  validateValues,
  type BaseResource,
  type CredentialMarker,
} from "@notation/resource";
import { isCreatingRecord, type StateNode } from "@notation/state";
import { recordSecretValue } from "@notation/utils";

// The values of credentials, by version. They are kept here only, for the
// life of the process, so a resumed deploy starts with none.
const held = new Map<string, unknown>();

/**
 * Keeps a credential's value in memory, and returns the version that names
 * it. A string value is removed from error messages from then on.
 */
export function holdCredential(value: unknown): string {
  if (typeof value === "string") recordSecretValue(value);
  const version = randomUUID();
  held.set(version, value);
  return version;
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
 * credential that create did not return, or whose value fails its validator,
 * gets no version.
 */
export async function holdCreated(
  resource: BaseResource,
  result: {} | void,
): Promise<{ key: {} | void; credentials?: Record<string, string> }> {
  const names = credentialNames(resource.schema);
  if (names.length === 0 || !result) return { key: result };
  const key: Record<string, unknown> = { ...result };
  const credentials: Record<string, string> = {};
  for (const name of names) {
    const value = key[name];
    delete key[name];
    if (value === undefined) continue;
    try {
      await validateValues(resource, { [name]: value }, "create");
    } catch {
      continue;
    }
    credentials[name] = holdCredential(value);
  }
  return { key, credentials };
}

/**
 * Copies a value, with the held value in place of each credential marker.
 * Throws for a marker whose value is not held.
 */
export function revealCredentials<T>(value: T): T {
  return mapCredentialMarkers(value, (marker) => {
    const { resource, name, version } = marker.$credential;
    if (!holdsCredential(version)) {
      throw new Error(
        `Deploy holds no value for the credential ${name} of ${resource}`,
      );
    }
    return held.get(version!);
  }) as T;
}

/**
 * `revealCredentials` for the params of an update. A param that holds a
 * credential whose value is not held is left out.
 */
export function revealHeldCredentials(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const revealed: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(params)) {
    if (unheldCredentials(value).length > 0) continue;
    revealed[field] = revealCredentials(value);
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
