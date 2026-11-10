import { scopedPhysicalName } from "@notation/resource";

// A Worker's name is a DNS label on workers.dev, so it is at most 63
// characters, of lowercase letters, digits and hyphens.
const WORKER_NAME_MAX_LENGTH = 63;

const WORKER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const WORKER_ID_RULE = `1 to ${WORKER_NAME_MAX_LENGTH} lowercase letters, digits or hyphens, not starting or ending with a hyphen`;

const NAMESPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NAMESPACE_ID_RULE = "1 to 64 letters, digits, hyphens or underscores";

/**
 * Throws when a Worker's `id` or `name` is not valid. `caller` names the
 * function that declares the Worker, such as `$worker`, in the error.
 */
export function assertWorkerId(
  caller: string,
  option: "id" | "name",
  value: unknown,
): asserts value is string {
  if (value === undefined || value === null || value === "") {
    throw new Error(
      `${caller} requires an ${option}: ${WORKER_ID_RULE}. The id keys the Worker in state and is the default base of its name, so keep it stable.`,
    );
  }
  if (
    typeof value !== "string" ||
    value.length > WORKER_NAME_MAX_LENGTH ||
    !WORKER_ID_PATTERN.test(value)
  ) {
    throw new Error(
      `Invalid ${caller} ${option} ${JSON.stringify(value)}: use ${WORKER_ID_RULE}.`,
    );
  }
}

export function assertNamespaceId(
  caller: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== "string" || !NAMESPACE_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${caller} id ${JSON.stringify(value)}: use ${NAMESPACE_ID_RULE}. The id keeps the namespace's objects when its class is renamed, so keep it stable.`,
    );
  }
}

/**
 * Makes the name of a Worker from its id or name: `<app>--<stage>--<name>`,
 * shortened with a hash when it is longer than 63 characters.
 */
export function workerName(name: string): string {
  return scopedPhysicalName(name, { maxLength: WORKER_NAME_MAX_LENGTH });
}
