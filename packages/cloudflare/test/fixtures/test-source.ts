import * as v from "valibot";
import { credentialSourceResource } from "@notation/resource";

/**
 * The values of the test sources, by key. A test sets `revision` to say
 * that the value changed.
 */
export const sourceValues = new Map<
  string,
  { value: string; revision: string }
>();

/** The keys that `loadCredential` was called for, in order. */
export const loads: string[] = [];

/** A source whose value and revision a test sets in `sourceValues`. */
export const TestSource = credentialSourceResource<{
  Params: { key: string };
  Value: string;
}>({ type: "test/sources/TestSource", provider: "test" })
  .defineSchema({
    key: { propertyType: "param", presence: "required", value: v.string() },
    revision: {
      propertyType: "computed",
      presence: "required",
      value: v.string(),
    },
    value: { propertyType: "credential", value: v.string() },
  } as const)
  .defineOperations({
    read: async (params) => ({ revision: entry(params.key).revision }),
    loadCredential: async (state) => {
      loads.push(state.key);
      return entry(state.key).value;
    },
  });

function entry(key: string) {
  const found = sourceValues.get(key);
  if (!found) throw new Error(`The test set no value for ${key}`);
  return found;
}
