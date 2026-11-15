import type { Schema } from "./resource.schema";
import { isPlainObject } from "./output-ref";

/**
 * Stands in for the value of a credential in params, state and step results.
 * Deploy holds the value in memory, and puts it in place of the marker only
 * for the call to an operation.
 *
 * `version` names one value. A create or a rotate gives the credential a new
 * version, so the params of each resource that takes the credential change,
 * and deploy updates it. A null version means that deploy holds no value and
 * has to get a new one before a resource can take it.
 */
export type CredentialMarker = {
  $credential: { resource: string; name: string; version: string | null };
};

export function credentialMarker(
  resource: string,
  name: string,
  version: string | null,
): CredentialMarker {
  return { $credential: { resource, name, version } };
}

export function isCredentialMarker(value: unknown): value is CredentialMarker {
  if (!isPlainObject(value)) return false;
  const marker = value.$credential;
  return (
    isPlainObject(marker) &&
    typeof marker.resource === "string" &&
    typeof marker.name === "string"
  );
}

/** The names of the schema's `credential` properties. */
export function credentialNames(schema: Schema): string[] {
  return Object.keys(schema).filter(
    (key) => schema[key]!.propertyType === "credential",
  );
}

/**
 * Copies a value, replacing every credential marker in it with the result of
 * `onMarker`.
 */
export function mapCredentialMarkers(
  value: unknown,
  onMarker: (marker: CredentialMarker) => unknown,
): unknown {
  if (isCredentialMarker(value)) return onMarker(value);
  if (Array.isArray(value)) {
    return value.map((entry) => mapCredentialMarkers(entry, onMarker));
  }
  if (isPlainObject(value)) {
    const mapped: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      mapped[key] = mapCredentialMarkers(entry, onMarker);
    }
    return mapped;
  }
  return value;
}

/** Every credential marker in a value. */
export function findCredentialMarkers(value: unknown): CredentialMarker[] {
  const found: CredentialMarker[] = [];
  mapCredentialMarkers(value, (marker) => found.push(marker));
  return found;
}
