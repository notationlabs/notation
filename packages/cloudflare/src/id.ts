import crypto from "node:crypto";
import {
  GENERATED_INSTANCE_LENGTH,
  generatedNameBody,
  getActiveResourceCollection,
  type PhysicalNameRule,
} from "@notation/resource";

// A Worker's name is the first label of its workers.dev URL, and a DNS label
// holds 63 characters. A preview URL puts an 8 character version prefix and
// a hyphen in the same label, which leaves 54. Cloudflare enforces this: it
// refuses to turn on workers.dev with preview URLs for a longer name (error
// 100315), and refuses workers.dev for a name of more than 63 characters
// (error 100132).
export const WORKER_NAME_MAX_LENGTH = 54;

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
 * collection's scope, other than through its state record. `nameBody` is its
 * generated name without the `-<instance>` at the end, cut as deploy cuts it
 * to fit the limit. Without a scope, `nameBody` is the id.
 */
export function workerNames(id: string): { nameBody: string } {
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
  return { nameBody };
}

/**
 * Whether `scriptName` is a name that `workerNames` describes: the name body
 * followed by `-` and 8 hex characters.
 */
export function matchesWorkerNames(
  scriptName: string,
  names: { nameBody: string },
): boolean {
  const prefix = `${names.nameBody}-`;
  return (
    scriptName.startsWith(prefix) &&
    new RegExp(`^[0-9a-f]{${GENERATED_INSTANCE_LENGTH}}$`).test(
      scriptName.slice(prefix.length),
    )
  );
}

// The namespace id in lower case, with each run of other characters than
// `a-z` and `0-9` replaced by one `-`.
const namespaceBase = (namespaceId: string) =>
  namespaceId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * The name of the container application of the namespace with the id
 * `namespaceId`: `<app>-<stage>-<id>-<hash>`, with the id as `namespaceBase`
 * makes it. Cloudflare refuses a name with `--`, so the name can't take the
 * `<app>--<stage>--` form, and app, stage and id can't be told apart by the
 * hyphens. The hash is the start of a SHA-256 of the app, stage and id, so
 * the name is unique for each of them. The name doesn't depend on the
 * hosting Worker, so a move to another Worker keeps it.
 */
export function containerApplicationName(namespaceId: string): string {
  const scope = getActiveResourceCollection()?.scope;
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify([scope?.app, scope?.stage, namespaceId]))
    .digest("hex")
    .slice(0, 8);
  const name = [scope?.app, scope?.stage, namespaceBase(namespaceId), hash]
    .filter(Boolean)
    .join("-");
  // Cloudflare refuses a name that starts with a digit, and an app name can.
  return /^[0-9]/.test(name) ? `c-${name}` : name;
}

/**
 * The default repository of the image of the namespace with the id
 * `namespaceId`: `<app>--<stage>--<id>`, with the id as `namespaceBase` makes
 * it. Two ids that give the same repository share it, which does no harm, as
 * each image's tag is a hash of its build input.
 */
export function containerRepositoryName(namespaceId: string): string {
  const scope = getActiveResourceCollection()?.scope;
  const base = namespaceBase(namespaceId) || "namespace";
  return scope ? `${scope.app}--${scope.stage}--${base}` : base;
}
