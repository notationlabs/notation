import { Redacted, recordSecretValue, secretContext } from "@notation/core";

/**
 * Fetches the value of the secret declared with `id`, for a resource that
 * writes it. It calls `get` on the secret's source. A secret without a source
 * takes its value from the prompt, and fails when there is no one to ask.
 * `notation secret set` supplies the value instead.
 *
 * The CLI removes every value that this returns from what it prints.
 */
export async function getValue(id: string): Promise<Redacted<string>> {
  const context = secretContext();
  if (!context) {
    throw new Error(
      `The value of the secret \`${id}\` can only be read in notation deploy or notation secret set.`,
    );
  }
  const value = await readValue(id);
  recordSecretValue(value.unwrap());
  return value;
}

async function readValue(id: string): Promise<Redacted<string>> {
  const context = secretContext()!;
  if (context.supplied?.id === id) return context.supplied.value;
  const declared = context.declared.get(id);
  if (!declared) {
    throw new Error(`No secret has the id "${id}".`);
  }
  const { stage } = context;
  if (declared.source) {
    const value = await declared.source.get(declared.key!, { stage });
    if (!Redacted.is(value)) {
      throw new Error(
        `The ${declared.source.name} source returned a value for \`${declared.key}\` that isn't a Redacted.`,
      );
    }
    return value as Redacted<string>;
  }
  if (!context.prompt) {
    throw new Error(
      `Secret \`${id}\` isn't set for stage ${stage}. Run \`notation secret set ${id} --stage ${stage}\`.`,
    );
  }
  return new Redacted(await context.prompt({ id, stage }));
}

/**
 * True when `notation secret set` is writing the value of the secret declared
 * with `id`. A resource uses it to write a secret that already exists, which
 * it otherwise leaves for a secret without a source.
 */
export function isValueSupplied(id: string): boolean {
  return secretContext()?.supplied?.id === id;
}
