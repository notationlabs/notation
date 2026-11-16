import type {
  CredentialSourceContext,
  CredentialSourceReadContext,
} from "@notation/resource";
import { recordSecretValue } from "@notation/utils";
import { trackRevision, type Track } from "./track";

// An empty value counts as not set.
export function lookup(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

/**
 * The revision of a source whose value has no version: the execution ID, or
 * with `track` a hash of the value. With `track` and no value, it is the
 * revision in state, with a warning, and fails when state has none.
 */
export async function localRevision(
  track: Track | undefined,
  read: () => Promise<string | undefined>,
  // Says why there is no value, such as "STRIPE_KEY is not set".
  unset: string,
  context: CredentialSourceReadContext<{ revision: string }>,
): Promise<string> {
  if (!track) return context.executionId;
  const value = await read();
  if (value === undefined) {
    const recorded = context.state?.revision;
    if (recorded === undefined) throw new Error(`${unset}.`);
    context.warn(`${unset}. Its value was not checked for a change.`);
    return recorded;
  }
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
  unset: string,
  revision: string,
  context: CredentialSourceContext,
): Promise<string> {
  const value = await read();
  if (value === undefined) throw new Error(`${unset}.`);
  if (track && (await trackRevision(track, context, value)) !== revision) {
    throw new Error(
      `The value of ${context.id} changed after deploy read it. Run deploy again.`,
    );
  }
  return value;
}
