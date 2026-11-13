import { Redacted } from "./redacted";
import { recordSecret } from "./scrub";
import {
  getSecretsState,
  type SecretPromptContext,
  type SecretPromptHandler,
  type SecretSource,
  type SecretTarget,
} from "./state";

export type {
  SecretPromptContext,
  SecretPromptHandler,
  SecretSource,
  SecretTarget,
};

/**
 * Registers a secret declaration target so `getValue` and `notation secret`
 * commands can resolve its source, key, resource, and token flag without
 * importing provider packages.
 */
export function registerSecretTarget(target: SecretTarget): void {
  getSecretsState().secretTargets.set(target.id, target);
}

/**
 * Returns the registered secret target for logical secret `id`, if any.
 */
export function getSecretTarget(id: string): SecretTarget | undefined {
  return getSecretsState().secretTargets.get(id);
}

/**
 * Lists all registered secret targets in registration order.
 */
export function listSecretTargets(): SecretTarget[] {
  return [...getSecretsState().secretTargets.values()];
}

/**
 * Clears all registered secret targets (called before graph evaluation and in tests).
 */
export function clearSecretTargets(): void {
  getSecretsState().secretTargets.clear();
}

/**
 * Runs `fn` with a scoped prompt handler in the active execution context.
 */
export function runWithSecretPromptHandler<T>(
  handler: SecretPromptHandler | undefined,
  fn: () => T,
): T {
  const { executionContextStorage } = getSecretsState();
  const parent = executionContextStorage.getStore();
  return executionContextStorage.run(
    { ...parent, promptHandler: handler },
    fn,
  );
}

/**
 * Prompts for a secret without a source using the active prompt handler, or
 * throws the non-interactive instructions error when none is configured.
 */
export async function promptSecretValue(
  context: SecretPromptContext,
): Promise<Redacted<string>> {
  const handler = getSecretsState().executionContextStorage.getStore()?.promptHandler;
  if (!handler) {
    throw new Error(
      `Secret ${context.id} isn't set for stage ${context.stage}. Run notation secret set ${context.id} --stage ${context.stage}.`,
    );
  }
  const result = await handler(context);
  const redacted = Redacted.is<string>(result) ? result : new Redacted(result);
  recordSecret(redacted.unwrap());
  return redacted;
}

/**
 * Runs `fn` with preset secret values (e.g. from `notation secret set`),
 * causing `getValue(id)` to return the preset value directly and record it for
 * scrubbing.
 */
export function runWithSecretValues<T>(
  values: Record<string, string | Redacted<string>>,
  fn: () => T,
): T {
  const { executionContextStorage } = getSecretsState();
  const parent = executionContextStorage.getStore();
  const merged = new Map(parent?.secretValues);
  for (const [id, rawOrRedacted] of Object.entries(values)) {
    const redacted = Redacted.is<string>(rawOrRedacted)
      ? rawOrRedacted
      : new Redacted(rawOrRedacted);
    recordSecret(redacted.unwrap());
    merged.set(id, redacted);
  }
  return executionContextStorage.run(
    { ...parent, secretValues: merged },
    fn,
  );
}

/**
 * Returns the preset secret value for `id` if running inside
 * `runWithSecretValues`.
 */
export function getPresetSecretValue(id: string): Redacted<string> | undefined {
  return getSecretsState().executionContextStorage.getStore()?.secretValues?.get(
    id,
  );
}
