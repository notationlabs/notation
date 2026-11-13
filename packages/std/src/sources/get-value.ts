import { Redacted, recordSecretValue, secretContext } from "@notation/core";

/**
 * Fetches the value of the secret declared with `id`, for a resource that
 * writes it. It calls `get` on the secret's source. A secret without a source
 * takes its value from the prompt, and fails when there is no one to ask.
 * The prompt is asked once per run for each secret. An empty value fails.
 *
 * The CLI removes every value that this returns from what it prints.
 */
export async function getValue(id: string): Promise<Redacted<string>> {
  const context = secretContext();
  if (!context) {
    throw new Error(
      `The value of the secret \`${id}\` can only be read during notation deploy or notation watch.`,
    );
  }
  const declared = context.declared.get(id);
  if (!declared) {
    throw new Error(`No secret has the id "${id}".`);
  }
  const { stage } = context;
  const cached = context.prompted.get(id);
  if (cached) return cached;
  let value: Redacted<string>;
  let from: string;
  let prompted = false;
  if (declared.source) {
    value = await declared.source.get(declared.key!, { stage });
    from = `${declared.source.name} key \`${declared.key}\``;
  } else if (context.prompt) {
    value = new Redacted(await context.prompt({ id, stage }));
    from = "the prompt";
    prompted = true;
  } else {
    throw new Error(
      `Secret \`${id}\` isn't set for stage ${stage}. Run \`notation secret set ${id} --stage ${stage}\`.`,
    );
  }
  if (value.unwrap() === "") {
    throw new Error(`The value of the secret \`${id}\` from ${from} is empty.`);
  }
  recordSecretValue(value.unwrap());
  if (prompted) context.prompted.set(id, value);
  return value;
}
