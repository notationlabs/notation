import type {
  CredentialSourceContext,
  CredentialSourceReadContext,
} from "@notation/resource";
import { recordSecretValue } from "@notation/utils";
import { assertTrackKey, trackRevision, type Track } from "../../track";

/**
 * Why a source has no value, such as "STRIPE_KEY is not set" and
 * "STRIPE_KEY is empty".
 */
export type Missing = { unset: string; empty: string };

/**
 * The revision of a source whose value has no version: the execution ID, or
 * with `track` a hash of the value. With `track` and no value, it is the
 * revision in state, with a warning, and fails when state has none. An
 * empty value fails with `track`.
 */
export async function localRevision(
  track: Track | undefined,
  read: () => Promise<string | undefined>,
  missing: Missing,
  context: CredentialSourceReadContext<{ revision: string }>,
): Promise<string> {
  if (!track) return context.executionId;
  assertTrackKey(track);
  const value = await read();
  if (value === undefined) {
    const recorded = context.state?.revision;
    if (recorded === undefined) throw new Error(`${missing.unset}.`);
    context.warn(`${missing.unset}. Its value was not checked for a change.`);
    return recorded;
  }
  if (value === "") throw new Error(`${missing.empty}.`);
  recordSecretValue(value);
  return trackRevision(track, context, value);
}

/**
 * The value of a source whose value has no version. With `track`, it fails
 * when the value's hash is not `revision`, as the value changed after `read`.
 */
export async function loadLocalValue(
  track: Track | undefined,
  read: () => Promise<string | undefined>,
  missing: Missing,
  revision: string,
  context: CredentialSourceContext,
): Promise<string> {
  const value = await read();
  if (value === undefined) throw new Error(`${missing.unset}.`);
  if (value === "") throw new Error(`${missing.empty}.`);
  if (track && (await trackRevision(track, context, value)) !== revision) {
    throw new Error(
      `The value of ${context.id} changed after deploy read it. Run deploy again.`,
    );
  }
  return value;
}
