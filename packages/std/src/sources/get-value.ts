import {
  Redacted,
  getExecutionContext,
  getPresetSecretValue,
  getSecretTarget,
  listSecretTargets,
  promptSecretValue,
  recordSecret,
} from "@notation/core";

/**
 * Fetches the `Redacted<string>` value for secret declaration `id`, either
 * from a preset override (e.g. `notation secret set`), from its registered
 * `Source` + `key`, or via the configured prompt handler when it has no source.
 * Records the raw secret string for output/error scrubbing.
 */
export async function getValue(id: string): Promise<Redacted<string>> {
  const preset = getPresetSecretValue(id);
  if (preset !== undefined) {
    recordSecret(preset.unwrap());
    return preset;
  }

  const target = getSecretTarget(id);
  if (!target) {
    const known = listSecretTargets().map((t) => t.id);
    const knownText =
      known.length > 0 ? ` Known secrets: ${known.join(", ")}.` : "";
    throw new Error(`Unknown secret "${id}".${knownText}`);
  }

  const context = getExecutionContext();
  if (!context) {
    throw new Error(
      `Cannot get secret "${id}" outside of a plan, deploy, or execution context.`,
    );
  }

  if (target.source) {
    if (!target.key) {
      throw new Error(
        `Secret "${id}" has source "${target.source.name}" but no key.`,
      );
    }
    const value = await target.source.get(target.key, {
      stage: context.stage,
    });
    recordSecret(value.unwrap());
    return value;
  }

  return promptSecretValue({ id, stage: context.stage });
}
