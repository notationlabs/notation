import * as v from "valibot";
import { recordSecretValue } from "@notation/utils";
import { OnePasswordError, opItemGet } from "./op";
import { parseReference, type Reference } from "./reference";

// The number of `op` calls that run at the same time after the first. It is
// not part of the API, and can change in a patch release.
const CONCURRENT_CALLS = 8;

const NOTIFY_AFTER_MS = 2000;

const WAITING_MESSAGE =
  "Waiting for 1Password. Approve the request in the 1Password app.";

const fieldSchema = v.object({
  id: v.string(),
  label: v.optional(v.string()),
  type: v.string(),
  reference: v.optional(v.string()),
  value: v.optional(v.string()),
  section: v.optional(
    v.object({ id: v.string(), label: v.optional(v.string()) }),
  ),
});

// `v.object` drops every other key of `op`'s output.
const itemSchema = v.object({
  id: v.string(),
  version: v.number(),
  state: v.optional(v.string()),
  fields: v.optional(v.array(fieldSchema), []),
});

export type Field = v.InferOutput<typeof fieldSchema>;

/** An item, with the values of only the fields that its sources asked for. */
export type Item = v.InferOutput<typeof itemSchema>;

/** The items that `prefetch` fetched, by `entryKey`. */
export type Items = ReadonlyMap<string, Item>;

/** The key of the item that a reference names. References to the same item share it. */
export function entryKey(reference: Reference): string {
  return JSON.stringify([reference.vault, reference.item]);
}

type Source = { id: string; reference: string };

/**
 * Fetches the items of `sources`. The first item is fetched alone, as a
 * shell with no approval shows one prompt for each call that runs before the
 * user approves. The others are fetched once it has succeeded, at most eight
 * at a time. Throws for a failure that concerns every item.
 */
export async function prefetchItems(
  sources: Source[],
  notify: (message: string) => void,
): Promise<{ items: Items; failed: { id: string; error: Error }[] }> {
  const failed: { id: string; error: Error }[] = [];
  const entries = new Map<string, { id: string; reference: Reference }[]>();
  for (const source of sources) {
    let reference: Reference;
    try {
      reference = parseReference(source.reference);
    } catch (error) {
      failed.push({ id: source.id, error: error as Error });
      continue;
    }
    const key = entryKey(reference);
    entries.set(key, [...(entries.get(key) ?? []), { ...source, reference }]);
  }

  const items = new Map<string, Item>();
  const fetchEntry = async (
    key: string,
    entrySources: { id: string; reference: Reference }[],
  ) => {
    const references = entrySources.map((source) => source.reference);
    let item: Item;
    try {
      item = await fetchItem(references[0]!, references);
    } catch (error) {
      if (!concernsOneItem(error)) throw error;
      for (const source of entrySources) {
        failed.push({
          id: source.id,
          error: forReference(error, source.reference),
        });
      }
      return;
    }
    items.set(key, item);
    for (const source of entrySources) {
      try {
        resolveValue(item, source.reference);
      } catch (error) {
        failed.push({ id: source.id, error: error as Error });
      }
    }
  };

  const [first, ...rest] = entries;
  if (!first) return { items, failed };
  const timer = setTimeout(() => notify(WAITING_MESSAGE), NOTIFY_AFTER_MS);
  try {
    await fetchEntry(...first);
  } finally {
    clearTimeout(timer);
  }

  let next = 0;
  let stopped: { error: unknown } | undefined;
  const worker = async () => {
    while (!stopped && next < rest.length) {
      const entry = rest[next++]!;
      try {
        await fetchEntry(...entry);
      } catch (error) {
        stopped ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENT_CALLS, rest.length) }, worker),
  );
  if (stopped) throw stopped.error;
  return { items, failed };
}

/**
 * Returns the item of `reference` from `items`, or fetches it alone when
 * `prefetch` was not given its source.
 */
export async function getItem(
  reference: Reference,
  items: Items | undefined,
): Promise<Item> {
  const item = items?.get(entryKey(reference));
  if (item) return item;
  try {
    return await fetchItem(reference, [reference]);
  } catch (error) {
    if (concernsOneItem(error)) throw forReference(error, reference);
    throw error;
  }
}

/**
 * Fetches one item with `op item get`, and records its values so that
 * errors scrub them. Only the values of the fields that `references` name
 * are kept.
 */
async function fetchItem(
  entry: Reference,
  references: Reference[],
): Promise<Item> {
  let stdout: string;
  try {
    stdout = await opItemGet(entry.item, entry.vault);
  } catch (error) {
    throw withAdvice(error);
  }
  const item = decode(stdout);
  for (const field of item.fields) {
    // A short value, such as a PIN, is not recorded: the scrubber replaces
    // every occurrence of a recorded value, so it would hide ordinary text.
    if (field.type === "CONCEALED" && field.value && field.value.length >= 8) {
      recordSecretValue(field.value);
    }
  }
  const requested = new Set<Field>();
  for (const reference of references) {
    try {
      const field = matchField(item, reference);
      if (field.value) recordSecretValue(field.value);
      requested.add(field);
    } catch {
      // `resolveValue` throws this again for the source.
    }
  }
  return {
    ...item,
    fields: item.fields.map((field) =>
      requested.has(field) ? field : { ...field, value: undefined },
    ),
  };
}

// The message of `JSON.parse` and the issues of valibot hold part of the
// input, and the input holds values.
function decode(stdout: string): Item {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw unreadable();
  }
  const result = v.safeParse(itemSchema, json);
  if (!result.success) throw unreadable();
  return result.output;
}

function unreadable(): Error {
  return new Error("1Password returned output that notation can't read.");
}

/** Returns the value of the field that `reference` names in `item`. */
export function resolveValue(item: Item, reference: Reference): string {
  // `op` finds an archived item by ID, so a reference with IDs would keep
  // deploying it.
  if (item.state === "ARCHIVED") {
    throw new Error(
      `The item of \`${reference.text}\` is archived in 1Password. Restore it, or change the reference.`,
    );
  }
  const value = matchField(item, reference).value ?? "";
  if (value === "") {
    throw new Error(`The value of \`${reference.text}\` is empty.`);
  }
  return value;
}

/**
 * Finds the one field that `reference` names, by its ID or its label. With
 * a section, only the fields in that section match.
 */
function matchField(item: Item, reference: Reference): Field {
  const names = (name: string, thing: { id: string; label?: string }) =>
    thing.id === name || thing.label === name;
  const { section } = reference;
  const candidates =
    section === undefined
      ? item.fields
      : item.fields.filter(
          (field) => field.section && names(section, field.section),
        );
  const found = candidates.filter((field) => names(reference.field, field));
  if (found.length === 1) return found[0]!;
  const fields = item.fields
    .map((field) => field.reference)
    .filter((text): text is string => text !== undefined);
  throw new Error(
    [
      found.length === 0
        ? `No field of the item matches \`${reference.text}\`.`
        : `More than one field of the item matches \`${reference.text}\`. Add the section to the reference, or use the field's ID.`,
      fields.length === 0
        ? "The item has no fields."
        : `The fields of the item are:\n${fields.map((text) => `  ${text}`).join("\n")}`,
    ].join(" "),
  );
}

// `op` signs in before it prints these, so the calls after one of them
// need no approval.
function concernsOneItem(error: unknown): error is OnePasswordError {
  return (
    error instanceof OnePasswordError &&
    /isn't an item|More than one item matches/.test(error.stderr)
  );
}

function forReference(
  error: OnePasswordError,
  reference: Reference,
): OnePasswordError {
  return new OnePasswordError(
    `Can't fetch \`${reference.text}\`. ${error.message}`,
    error.exitCode,
    error.stderr,
  );
}

function withAdvice(error: unknown): unknown {
  if (!(error instanceof OnePasswordError)) return error;
  let advice: string | undefined;
  if (error.stderr.includes("authorization timeout")) {
    advice =
      "No one approved the request in the 1Password app. A process with no person to approve it, such as an agent or a CI job, needs a 1Password service account in OP_SERVICE_ACCOUNT_TOKEN.";
  } else if (
    /isn't an item|isn't a vault/.test(error.stderr) &&
    !process.env.OP_SERVICE_ACCOUNT_TOKEN &&
    !process.env.OP_CONNECT_HOST
  ) {
    advice = process.env.OP_ACCOUNT
      ? `op looked in the account in OP_ACCOUNT, \`${process.env.OP_ACCOUNT}\`.`
      : "op looked in the account that you signed in to last. Set OP_ACCOUNT to choose another.";
  }
  if (!advice) return error;
  return new OnePasswordError(
    `${error.message} ${advice}`,
    error.exitCode,
    error.stderr,
  );
}
