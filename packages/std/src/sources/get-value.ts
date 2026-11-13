import { Redacted, recordSecretValue, secretContext } from "@notation/core";

/**
 * Fetches the value of the secret declared with `id`, for a resource that
 * writes it. It calls `get` on the secret's source. A secret without a source
 * takes its value from the prompt, and fails when there is no one to ask.
 * The prompt is asked once per run for each secret.
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
  const declared = context.declared.get(id);
  if (!declared) {
    throw new Error(`No secret has the id "${id}".`);
  }
  const { stage } = context;
  let value: Redacted<string>;
  if (context.supplied?.id === id) {
    value = context.supplied.value;
  } else if (declared.source) {
    value = await declared.source.get(declared.key!, { stage });
  } else if (context.prompted.has(id)) {
    value = context.prompted.get(id)!;
  } else if (context.prompt) {
    value = new Redacted(await context.prompt({ id, stage }));
    context.prompted.set(id, value);
  } else {
    throw new Error(
      `Secret \`${id}\` isn't set for stage ${stage}. Run \`notation secret set ${id} --stage ${stage}\`.`,
    );
  }
  recordSecretValue(value.unwrap());
  return value;
}

/**
 * True when `notation secret set` is writing the value of the secret declared
 * with `id`. A resource uses it to write a secret that already exists, which
 * it otherwise leaves for a secret without a source.
 */
export function isValueSupplied(id: string): boolean {
  return secretContext()?.supplied?.id === id;
}
