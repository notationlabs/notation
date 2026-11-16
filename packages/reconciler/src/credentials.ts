import { createHash, randomUUID } from "node:crypto";
import {
  credentialMarker,
  credentialNames,
  findCredentialMarkers,
  forEachOutputRef,
  isCredentialMarker,
  isCredentialSource,
  isPlainObject,
  mapCredentialMarkers,
  toComparableParams,
  validateValues,
  type BaseResource,
  type CredentialMarker,
  type RecordedOutputs,
} from "@notation/resource";
import { isCreatingRecord, type StateNode } from "@notation/state";
import { recordSecretValue, sortedJson } from "@notation/utils";

// The values of credentials, by version. They are kept here only, for the
// life of the process, so a resumed deploy starts with none. A process runs
// one deploy: `credentialsToMint` reads records and not this map, so a
// second deploy in the process would rotate a credential whose value is
// still held.
const held = new Map<string, unknown>();

// The versions whose values an operation of each resource has received, in
// this process. An operation that is replayed from the journal receives none.
const given = new WeakMap<BaseResource, Set<string>>();

// The error that an operation of each resource throws when it reveals a
// credential that deploy cannot get, by the credential's resource and name.
const unobtainable = new WeakMap<BaseResource, Map<string, Error>>();

/**
 * Sets the error that `revealCredentials` throws when an operation of
 * `taker` receives the credential `name` of `resource` and deploy holds no
 * value for it.
 */
export function deferUnobtainable(
  taker: BaseResource,
  resource: string,
  name: string,
  error: Error,
): void {
  if (!unobtainable.has(taker)) unobtainable.set(taker, new Map());
  unobtainable.get(taker)!.set(`${resource}.${name}`, error);
}

/**
 * Keeps a credential's value in memory, and returns the version that names
 * it: `version`, or a new one. Every string in the value is removed from
 * error messages from then on.
 */
export function holdCredential(
  value: unknown,
  version: string = randomUUID(),
): string {
  recordSecretStrings(value);
  held.set(version, value);
  return version;
}

/**
 * The version of a source's credential: a SHA-256 of the source's ID, the
 * credential's name, its comparable params and its revision. A source with
 * the same params and revision gives the same version in every deploy, so
 * loading the value again changes no resource that takes it.
 */
export function sourceCredentialVersion(
  source: BaseResource,
  name: string,
  params: Record<string, unknown>,
  revision: unknown,
): string {
  return createHash("sha256")
    .update(
      sortedJson.encode([
        source.id,
        name,
        toComparableParams(source.schema, params),
        revision,
      ]),
    )
    .digest("hex");
}

/** Removes every string in `value` from error messages from now on. */
export function recordSecretStrings(value: unknown): void {
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
 * Throws for a marker whose value is not held: the error that
 * `deferUnobtainable` set, if any. `taker` is the resource whose operation
 * receives the copy.
 *
 * With `recorded`, a marker that `recorded` holds at the same path is
 * `undefined` in the copy: the record of `taker` shows that it already has
 * that version there.
 */
export function revealCredentials<T>(
  value: T,
  taker: BaseResource,
  recorded?: unknown,
): T {
  return mapChangedCredentials(value, recorded, (marker) => {
    const { resource, name, version } = marker.$credential;
    if (!holdsCredential(version)) {
      throw (
        unobtainable.get(taker)?.get(`${resource}.${name}`) ??
        new Error(
          `Deploy holds no value for the credential ${name} of ${resource}`,
        )
      );
    }
    if (!given.has(taker)) given.set(taker, new Set());
    given.get(taker)!.add(version!);
    return held.get(version!);
  }) as T;
}

/**
 * The credential markers in `value` that `recorded` does not hold at the
 * same path.
 */
export function changedCredentials(
  value: unknown,
  recorded: unknown,
): CredentialMarker[] {
  const changed: CredentialMarker[] = [];
  mapChangedCredentials(value, recorded, (marker) => changed.push(marker));
  return changed;
}

/**
 * Copies a value, with `onMarker` applied to each credential marker that
 * differs from the value at the same path in `recorded`. A marker that is
 * the same there is `undefined` in the copy. A marker found at another path
 * does not count: a resource that took the credential under one name has
 * not taken it under another.
 */
function mapChangedCredentials(
  value: unknown,
  recorded: unknown,
  onMarker: (marker: CredentialMarker) => unknown,
): unknown {
  if (isCredentialMarker(value)) {
    return isCredentialMarker(recorded) && sameMarker(value, recorded)
      ? undefined
      : onMarker(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      mapChangedCredentials(
        entry,
        Array.isArray(recorded) ? recorded[index] : undefined,
        onMarker,
      ),
    );
  }
  if (isPlainObject(value)) {
    const previous = isPlainObject(recorded) ? recorded : {};
    const mapped: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      mapped[key] = mapChangedCredentials(entry, previous[key], onMarker);
    }
    return mapped;
  }
  return value;
}

function sameMarker(a: CredentialMarker, b: CredentialMarker): boolean {
  return (
    a.$credential.resource === b.$credential.resource &&
    a.$credential.name === b.$credential.name &&
    a.$credential.version === b.$credential.version
  );
}

/**
 * The credentials in `markers` whose values an operation of `taker` has not
 * received in this process. The credentials of the sources among
 * `resources` are left out: a source gives the same value for the same
 * version, so an operation replayed from the journal received that value.
 * The credentials without `rotate` are left out too: the resource received
 * their value when the operation first ran.
 */
export function ungivenCredentials(
  taker: BaseResource,
  markers: readonly CredentialMarker[],
  resources: readonly BaseResource[],
): CredentialMarker[] {
  return markers.filter(({ $credential }) => {
    const producer = resources.find(({ id }) => id === $credential.resource);
    if (producer && isCredentialSource(producer)) return false;
    // Deploy cannot give the value of a credential without `rotate` again.
    if (producer && !producer.rotate?.[$credential.name]) return false;
    return !(given.get(taker)?.has($credential.version ?? "") ?? false);
  });
}

/**
 * Copies a value, with no version in each credential marker whose version
 * is in `versions`, as in the record of a resource that has not taken those
 * values.
 */
export function staleCredentialMarkers<T>(
  value: T,
  versions: readonly string[],
): T {
  return mapCredentialMarkers(value, (marker) => {
    const { resource, name, version } = marker.$credential;
    return version !== null && versions.includes(version)
      ? credentialMarker(resource, name, null)
      : marker;
  }) as T;
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

/** The credentials in `markers` whose values are not held, each once. */
export function unheldCredentials(
  markers: readonly CredentialMarker[],
): CredentialMarker[] {
  const seen = new Set<string>();
  return markers.filter((marker) => {
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
 * The credentials of `producer` that need a new value, each with the first
 * resource that needs it. A resource takes the credential, and one of these
 * holds:
 *
 * 1. The output in the producer's record has no version for it.
 * 2. A resource that takes it has no record, or a "creating" record.
 * 3. The record of a resource that takes it does not hold the version at
 *    each path where its params take it, as `changedCredentials` compares
 *    them. An earlier deploy failed before it updated the resource, or the
 *    resource now takes the credential under another name, such as a
 *    renamed Worker secret.
 *
 * A source's credential is never in the list: deploy loads its value again.
 */
export async function credentialsToMint(
  producer: BaseResource,
  output: Record<string, unknown>,
  consumers: readonly { resource: BaseResource; record?: StateNode }[],
  recordedOutputs: RecordedOutputs,
): Promise<{ name: string; consumer: BaseResource }[]> {
  if (isCredentialSource(producer)) return [];
  const planned = new Map<BaseResource, Promise<Record<string, unknown>>>();
  const paramsOf = (resource: BaseResource) => {
    if (!planned.has(resource)) {
      planned.set(resource, resource.planParams({ recordedOutputs }));
    }
    return planned.get(resource)!;
  };
  const needed: { name: string; consumer: BaseResource }[] = [];
  for (const name of credentialNames(producer.schema)) {
    const marker = output[name];
    const current =
      isCredentialMarker(marker) && marker.$credential.version !== null
        ? marker
        : null;
    const isThis = ({ $credential }: CredentialMarker) =>
      $credential.resource === producer.id && $credential.name === name;
    for (const { resource, record } of consumers) {
      if (!takesCredential(resource, producer, name)) continue;
      const needs =
        !current ||
        !record ||
        isCreatingRecord(record) ||
        changedCredentials(
          mapCredentialMarkers(await paramsOf(resource), (found) =>
            isThis(found) ? current : found,
          ),
          record.params,
        ).some(isThis);
      if (needs) {
        needed.push({ name, consumer: resource });
        break;
      }
    }
  }
  return needed;
}

/** The version that the producer's output holds for the credential. */
export function credentialVersion(
  producer: BaseResource,
  name: string,
): string | null {
  const marker = (producer.output as Record<string, unknown> | null)?.[name];
  return isCredentialMarker(marker) ? marker.$credential.version : null;
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
