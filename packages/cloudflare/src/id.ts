import {
  GENERATED_INSTANCE_LENGTH,
  generatedNameBody,
  getActiveResourceCollection,
  scopedPhysicalName,
  type PhysicalNameRule,
} from "@notation/resource";

// A Worker's name is the first label of its workers.dev URL, and a DNS label
// holds 63 characters. A preview URL puts an 8 character version prefix and
// a hyphen in the same label, which leaves 54. Cloudflare enforces this: it
// refuses to turn on workers.dev with preview URLs for a longer name (error
// 100315), and refuses workers.dev for a name of more than 63 characters
// (error 100132).
export const WORKER_NAME_MAX_LENGTH = 54;

// The longest name that a Worker got before deploy generated its name.
const FIXED_WORKER_NAME_MAX_LENGTH = 63;

const WORKER_ID_MAX_LENGTH = 63;

const WORKER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const WORKER_ID_RULE = `1 to ${WORKER_ID_MAX_LENGTH} lowercase letters, digits or hyphens, not starting or ending with a hyphen`;

const NAMESPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NAMESPACE_ID_RULE = "1 to 64 letters, digits, hyphens or underscores";

/** The rule of a Worker's generated name, `<app>--<stage>--<id>-<instance>`. */
export const workerNameRule: PhysicalNameRule = {
  maxLength: WORKER_NAME_MAX_LENGTH,
  base: (resourceId) => resourceId.replace(/^worker:/, ""),
};

/** The id of a Worker's script resource, such as `worker:orders`. */
export const workerResourceId = (id: string) => `worker:${id}`;

/** Throws if a Worker's `id` is not valid. */
export function assertWorkerId(
  /** The declaring function, such as `$worker`, for the error. */
  caller: string,
  value: unknown,
): asserts value is string {
  if (value === undefined || value === null || value === "") {
    throw new Error(
      `${caller} requires an id: ${WORKER_ID_RULE}. The id keys the Worker in state and is the base of its name, so keep it stable.`,
    );
  }
  if (
    typeof value !== "string" ||
    value.length > WORKER_ID_MAX_LENGTH ||
    !WORKER_ID_PATTERN.test(value)
  ) {
    throw new Error(
      `Invalid ${caller} id ${JSON.stringify(value)}: use ${WORKER_ID_RULE}.`,
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
 * The names that the Worker with the id `id` can have in the active
 * collection's scope, other than through its state record:
 * - `nameBody`: its generated name without the `-<instance>` at the end,
 *   cut as deploy cuts it to fit the limit.
 * - `fixedName`: the name that the Worker got before deploy generated its
 *   name, `<app>--<stage>--<id>`, shortened with a hash past 63 characters.
 * Without a scope, `nameBody` is the id.
 */
export function workerNames(id: string): {
  nameBody: string;
  fixedName: string;
} {
  // Deploy generates names in `nameScope` (workflow.deploy.ts), which must
  // be the collection's scope, or `nameBody` describes the wrong name.
  const scope = getActiveResourceCollection()?.scope;
  const nameBody = scope
    ? generatedNameBody(
        scope,
        workerResourceId(id),
        workerNameRule,
        GENERATED_INSTANCE_LENGTH + 1,
      )
    : id;
  const fixedName = scopedPhysicalName(id, {
    maxLength: FIXED_WORKER_NAME_MAX_LENGTH,
  });
  return { nameBody, fixedName };
}

/**
 * Whether `scriptName` is a name that `workerNames` describes: the fixed
 * name, or the name body followed by `-` and 8 hex characters.
 */
export function matchesWorkerNames(
  scriptName: string,
  names: { nameBody: string; fixedName: string },
): boolean {
  if (scriptName === names.fixedName) return true;
  const prefix = `${names.nameBody}-`;
  return (
    scriptName.startsWith(prefix) &&
    new RegExp(`^[0-9a-f]{${GENERATED_INSTANCE_LENGTH}}$`).test(
      scriptName.slice(prefix.length),
    )
  );
}
