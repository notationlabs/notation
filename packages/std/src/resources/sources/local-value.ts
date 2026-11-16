import type {
  CredentialSourceContext,
  CredentialSourceReadContext,
} from "@notation/resource";
import { recordSecretValue } from "@notation/utils";
import { assertTrackKey, trackRevision, type Track } from "./track";

/**
 * A value that a source looked up. `unset` says why there is no value, such
 * as "STRIPE_KEY is not set", and is undefined when there is one.
 */
export type LocalValue =
  { value: string; unset?: undefined } | { unset: string };

export function lookup(
  value: string | undefined,
  name: string,
  where = "",
): LocalValue {
  if (value === undefined) return { unset: `${name} is not set${where}` };
  if (value === "") return { unset: `${name} is empty${where}` };
  return { value };
}

/**
 * The revision of a source whose value has no version: the execution ID, or
 * with `track` a hash of the value. With `track` and no value, it is the
 * revision in state, with a warning, and fails when state has none.
 */
export async function localRevision(
  track: Track | undefined,
  read: () => Promise<LocalValue>,
  context: CredentialSourceReadContext<{ revision: string }>,
): Promise<string> {
  if (!track) return context.executionId;
  assertTrackKey(track);
  const found = await read();
  if (found.unset !== undefined) {
    const recorded = context.state?.revision;
    if (recorded === undefined) throw new Error(`${found.unset}.`);
    context.warn(`${found.unset}. Its value was not checked for a change.`);
    return recorded;
  }
  recordSecretValue(found.value);
  return trackRevision(track, context, found.value);
}

/**
 * The value of a source whose value has no version. With `track`, it fails
 * when the value's hash is not `revision`, as the value changed after `read`.
 */
export async function loadLocalValue(
  track: Track | undefined,
  read: () => Promise<LocalValue>,
  revision: string,
  context: CredentialSourceContext,
): Promise<string> {
  const found = await read();
  if (found.unset !== undefined) throw new Error(`${found.unset}.`);
  if (
    track &&
    (await trackRevision(track, context, found.value)) !== revision
  ) {
    throw new Error(
      `The value of ${context.id} changed after deploy read it. Run deploy again.`,
    );
  }
  return found.value;
}
