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

// The messages of `op` for a failure that concerns one item.
const ONE_ITEM_ERROR =
  /isn't an item|isn't a vault|More than one item matches/;

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

type Field = v.InferOutput<typeof fieldSchema>;

type Item = v.InferOutput<typeof itemSchema>;

/** What `read` and `loadCredential` need of the field that a reference names. */
export type Entry = { id: string; version: number; value: string };

type Source = { id: string; reference: string };

/**
 * Fetches the items of `sources`, and returns the entry of each source by
 * its reference. The first item is fetched alone, as a shell with no
 * approval shows one prompt for each call that runs before the user
 * approves. The others are fetched once it has succeeded, at most eight at
 * a time. Throws for a failure that concerns every item.
 */
export async function prefetchItems(
  sources: Source[],
  notify: (message: string) => void,
): Promise<{
  prefetched: Map<string, Entry>;
  failed: { id: string; error: Error }[];
}> {
  const failed: { id: string; error: Error }[] = [];
  // The sources of each item, so that each item is fetched once.
  const items = new Map<string, { id: string; reference: Reference }[]>();
  for (const source of sources) {
    const reference = parseReference(source.reference);
    const key = JSON.stringify([reference.vault, reference.item]);
    items.set(key, [...(items.get(key) ?? []), { id: source.id, reference }]);
  }

  const prefetched = new Map<string, Entry>();
  const fetchSources = async (
    itemSources: { id: string; reference: Reference }[],
  ) => {
    let item: Item;
    try {
      item = await fetchItem(itemSources[0]!.reference);
    } catch (error) {
      if (!concernsOneItem(error)) throw error;
      for (const { id, reference } of itemSources) {
        failed.push({ id, error: forReference(error, reference) });
      }
      return;
    }
    for (const { id, reference } of itemSources) {
      try {
        prefetched.set(reference.text, toEntry(item, reference));
      } catch (error) {
        failed.push({ id, error: error as Error });
      }
    }
  };

  const [first, ...rest] = items.values();
  if (!first) return { prefetched, failed };
  // A service account or a Connect server needs no approval in the app.
  const timer = signsInWithoutApp()
    ? undefined
    : setTimeout(() => notify(WAITING_MESSAGE), NOTIFY_AFTER_MS);
  try {
    await fetchSources(first);
  } finally {
    clearTimeout(timer);
  }

  let next = 0;
  let stopped: { error: unknown } | undefined;
  const worker = async () => {
    while (!stopped && next < rest.length) {
      const itemSources = rest[next++]!;
      try {
        await fetchSources(itemSources);
      } catch (error) {
        stopped ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENT_CALLS, rest.length) }, worker),
  );
  if (stopped) throw stopped.error;
  return { prefetched, failed };
}

/** Fetches the item of `reference` alone, and returns its entry. */
export async function fetchEntry(reference: Reference): Promise<Entry> {
  let item: Item;
  try {
    item = await fetchItem(reference);
  } catch (error) {
    if (concernsOneItem(error)) throw forReference(error, reference);
    throw error;
  }
  return toEntry(item, reference);
}

/**
 * Fetches one item with `op item get`, and records its concealed values so
 * that errors scrub them.
 */
async function fetchItem(reference: Reference): Promise<Item> {
  let stdout: string;
  try {
    stdout = await opItemGet(reference.item, reference.vault);
  } catch (error) {
    throw withAdvice(error);
  }
  const item = decode(stdout);
  for (const field of item.fields) {
    // A short value of another field, such as a PIN, is not recorded: the
    // scrubber replaces every occurrence of a recorded value, so it would
    // hide ordinary text. `toEntry` records the value that the reference
    // names at any length, as it is the deployed credential.
    if (field.type === "CONCEALED" && field.value && field.value.length >= 8) {
      recordSecretValue(field.value);
    }
  }
  return item;
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

/**
 * Returns the entry of the field that `reference` names in `item`, and
 * records its value, whatever the field's type.
 */
function toEntry(item: Item, reference: Reference): Entry {
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
  recordSecretValue(value);
  return { id: item.id, version: item.version, value };
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
  return error instanceof OnePasswordError && ONE_ITEM_ERROR.test(error.stderr);
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
  } else if (ONE_ITEM_ERROR.test(error.stderr) && !signsInWithoutApp()) {
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

// `op` uses a service account or a Connect server, not the account of the
// desktop app.
function signsInWithoutApp(): boolean {
  return Boolean(
    process.env.OP_SERVICE_ACCOUNT_TOKEN || process.env.OP_CONNECT_HOST,
  );
}
