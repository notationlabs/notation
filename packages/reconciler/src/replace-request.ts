import { createHash } from "node:crypto";
import {
  isCredentialMarker,
  isCredentialSource,
  type BaseResource,
  type Schema,
} from "@notation/resource";
import { isCreatingRecord, type StateNode } from "@notation/state";

/** A resource that `--replace` names, as `<id>@<instance hash>`. */
export type ReplaceTarget = {
  id: string;
  /** Optional for plan, and required for deploy. */
  instanceHash?: string;
};

/**
 * A credential that `--credential` names, as
 * `<id>.<credential>@<version>=<variable>`.
 */
export type CredentialTarget = {
  id: string;
  name: string;
  /** Optional for plan, and required for deploy. */
  version?: string;
  /** The environment variable that holds the value. */
  variable: string;
};

/**
 * What the user asked deploy to do beyond the code: the replaces of
 * `--replace`, and the values of `--credential`.
 */
export type ReplaceRequest = {
  replace: ReplaceTarget[];
  /** IDs in `replace` whose class's `rejectChange` deploy skips. */
  overrideLossProtection?: string[];
  credential?: CredentialTarget[];
};

/** How deploy decides a resource that `--replace` names. */
export type RequestedReplace = { overrideLossProtection: boolean };

const INSTANCE_HASH = /^[0-9a-f]{8}$/i;
const HEX = /^[0-9a-f]+$/i;

/**
 * Reads `<id>@<instance hash>`. The ID is the part before the last `@`. A
 * value with no `@`, or whose part after the last `@` is not 8 hex
 * characters, is an ID with no hash. An uppercase hash is read as lowercase.
 */
export function parseReplaceTarget(value: string): ReplaceTarget {
  const at = value.lastIndexOf("@");
  const id = value.slice(0, at);
  const instanceHash = value.slice(at + 1);
  if (at <= 0 || !INSTANCE_HASH.test(instanceHash)) return { id: value };
  return { id, instanceHash: instanceHash.toLowerCase() };
}

/**
 * Throws if `value` is a known ID followed by `@` and hex characters of the
 * wrong length, which `parseReplaceTarget` read as an ID with no hash.
 */
function assertHashWellFormed(value: string, known: (id: string) => boolean) {
  const at = value.lastIndexOf("@");
  const id = value.slice(0, at);
  const hash = value.slice(at + 1);
  if (at <= 0 || !HEX.test(hash) || !known(id)) return;
  throw new Error(
    `The instance hash ${hash} of ${id} is malformed. An instance hash is 8 hex characters.`,
  );
}

/**
 * Reads `<id>.<credential>@<version>=<variable>`. The variable is the part
 * after the last `=`. The version is the part after the last `@` before it,
 * when that part holds no dot. The rest is split at its last dot, so an ID
 * can hold a dot.
 */
export function parseCredentialTarget(value: string): CredentialTarget {
  const equals = value.lastIndexOf("=");
  const variable = value.slice(equals + 1);
  const left = equals < 0 ? value : value.slice(0, equals);
  const at = left.lastIndexOf("@");
  const hasVersion = at > left.lastIndexOf(".");
  const target = hasVersion ? left.slice(0, at) : left;
  const version = hasVersion ? left.slice(at + 1) : undefined;
  const dot = target.lastIndexOf(".");
  const id = target.slice(0, dot);
  const name = target.slice(dot + 1);
  if (equals < 0 || !variable || dot <= 0 || !name || version === "") {
    throw new Error(
      `--credential ${value} is malformed. Give it as <resource id>.<credential>@<version>=<variable>.`,
    );
  }
  return {
    id,
    name,
    ...(version !== undefined ? { version: version.toLowerCase() } : {}),
    variable,
  };
}

/** A credential's version as plan prints it: its first 8 characters. */
export function shortVersion(version: string | null): string {
  return version === null ? "none" : version.slice(0, 8);
}

/** The request's `--credential` for the credential, if it has one. */
export function requestedCredential(
  request: ReplaceRequest | undefined,
  id: string,
  name: string,
): CredentialTarget | undefined {
  return request?.credential?.find(
    (target) => target.id === id && target.name === name,
  );
}

function primaryKeyNames(schema: Schema): string[] {
  return Object.entries(schema)
    .filter(([, item]) => (item as { primaryKey?: true }).primaryKey)
    .map(([name]) => name);
}

// The old `SourceValue` has no primary key, and every class that is not a
// source has one.
function isSource(resource: BaseResource): boolean {
  return (
    isCredentialSource(resource) ||
    primaryKeyNames(resource.schema).length === 0
  );
}

/**
 * The request as flags, in a fixed order, with each repeated flag once.
 * Empty for no request.
 */
export function formatRequest(request: ReplaceRequest | undefined): string {
  const flags = [
    ...(request?.replace ?? [])
      .map(({ id, instanceHash }) =>
        shellQuote(instanceHash ? `${id}@${instanceHash}` : id),
      )
      .map((value) => `--replace ${value}`)
      .sort(),
    ...(request?.overrideLossProtection ?? [])
      .map((id) => `--override-loss-protection ${shellQuote(id)}`)
      .sort(),
    ...(request?.credential ?? [])
      .map((target) => `--credential ${shellQuote(formatCredential(target))}`)
      .sort(),
  ];
  return [...new Set(flags)].join(" ");
}

export function formatCredential({
  id,
  name,
  version,
  variable,
}: CredentialTarget): string {
  return `${id}.${name}${version === undefined ? "" : `@${version}`}=${variable}`;
}

const SHELL_SAFE = /^[A-Za-z0-9_./:@=-]+$/;

/**
 * The value as one shell word. A value with a character outside
 * `[A-Za-z0-9_./:@=-]` is put in single quotes.
 */
export function shellQuote(value: string): string {
  if (SHELL_SAFE.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The first 8 hex characters of a SHA-256 of the deployment ID and the
 * primary key in the record's output. The deployment ID is included because
 * some primary keys are the same in every stage.
 */
export function instanceHash(
  deploymentId: string,
  resource: { schema: Schema },
  record: StateNode,
): string {
  const key = primaryKeyNames(resource.schema)
    .sort()
    .map((name) => [name, record.output[name] ?? null]);
  return createHash("sha256")
    .update(JSON.stringify([deploymentId, key]))
    .digest("hex")
    .slice(0, 8);
}

/** The options for `decideAction` when the request names the resource. */
export function requestedReplace(
  request: ReplaceRequest | undefined,
  id: string,
): RequestedReplace | undefined {
  if (!request?.replace.some((target) => target.id === id)) return undefined;
  return {
    overrideLossProtection: Boolean(
      request.overrideLossProtection?.includes(id),
    ),
  };
}

/**
 * Throws if the request names a resource that it cannot replace, or gives
 * an instance hash that does not match. Deploy requires each hash, and plan
 * checks a hash when it is given.
 */
export function assertReplaceRequest(
  request: ReplaceRequest | undefined,
  opts: {
    resources: BaseResource[];
    records: StateNode[];
    deploymentId: string;
    point: "plan" | "deploy";
  },
): void {
  if (!request) return;
  const ids = new Set(request.replace.map((target) => target.id));
  for (const id of request.overrideLossProtection ?? []) {
    if (!ids.has(id)) {
      throw new Error(
        `--override-loss-protection ${id} needs --replace ${id}.`,
      );
    }
  }
  const resourceById = new Map(opts.resources.map((r) => [r.id, r]));
  const recordById = new Map(opts.records.map((node) => [node.id, node]));
  for (const { id, instanceHash: given } of request.replace) {
    const resource = resourceById.get(id);
    const record = recordById.get(id);
    if (!record) {
      if (!resource) {
        assertHashWellFormed(
          id,
          (known) => resourceById.has(known) || recordById.has(known),
        );
      }
      throw new Error(
        resource
          ? `${id} is not in state, so there is nothing to replace. Deploy will create it.`
          : `${id} is not in state or in code, so there is nothing to replace.`,
      );
    }
    if (!resource) {
      throw new Error(`${id} is no longer in code. Deploy will delete it.`);
    }
    if (isCreatingRecord(record)) {
      throw new Error(
        `${id} has a create that an earlier deploy did not finish. Run deploy without --replace to recover it first.`,
      );
    }
    if (isSource(resource)) {
      throw new Error(
        `${id} is a source, and a source is never replaced. Nothing exists at a provider to replace.`,
      );
    }
    if (given === undefined) {
      if (opts.point === "plan") continue;
      // The CLI throws first, with the plan command to run.
      throw new Error(`--replace ${id} has no instance hash.`);
    }
    const actual = instanceHash(opts.deploymentId, resource, record);
    if (actual !== given) {
      throw new Error(
        `${id} has the instance hash ${actual} in this stage, not ${given}.`,
      );
    }
  }
  assertCredentialRequest(request, resourceById, recordById, opts.point);
}

/**
 * Throws if a `--credential` names a credential that it cannot set, gives a
 * version that is not the one in state, or names a variable that is not set
 * at deploy.
 */
function assertCredentialRequest(
  request: ReplaceRequest,
  resourceById: Map<string, BaseResource>,
  recordById: Map<string, StateNode>,
  point: "plan" | "deploy",
): void {
  const seen = new Set<string>();
  for (const target of request.credential ?? []) {
    const { id, name, version: given, variable } = target;
    const flag = `--credential ${id}.${name}`;
    if (seen.has(`${id}.${name}`)) {
      throw new Error(`${flag} is given more than once.`);
    }
    seen.add(`${id}.${name}`);
    const resource = resourceById.get(id);
    const record = recordById.get(id);
    if (!resource) {
      throw new Error(`${flag}: ${id} is not in code.`);
    }
    if (isCredentialSource(resource)) {
      throw new Error(
        `${flag}: ${id} is a source. Deploy loads a source's value from the source.`,
      );
    }
    if (resource.schema[name]?.propertyType !== "credential") {
      throw new Error(`${flag}: ${name} is not a credential of ${id}.`);
    }
    if (resource.rotate?.[name]) {
      throw new Error(
        `${flag}: ${resource.type} can rotate ${name}, so deploy gets a new value itself. --credential is accepted only for a credential without rotate.`,
      );
    }
    if (request.replace.some((replaced) => replaced.id === id)) {
      throw new Error(
        `${flag} cannot be given with --replace ${id}: the replacement is created with a new value.`,
      );
    }
    if (!record || isCreatingRecord(record)) {
      throw new Error(
        `${flag}: ${id} is not in state, so it has no value to set. Deploy creates it, and the create returns the value.`,
      );
    }
    if (given === undefined) {
      if (point === "plan") continue;
      throw new Error(`${flag} has no version.`);
    }
    const marker = record.output[name];
    const actual = isCredentialMarker(marker)
      ? marker.$credential.version
      : null;
    if (given !== shortVersion(actual) && given !== actual) {
      throw new Error(
        `${id}.${name} is at version ${shortVersion(actual)} in this stage, not ${given}.`,
      );
    }
    if (point === "deploy" && !process.env[variable]) {
      throw new Error(`${flag} reads ${variable}, which is not set.`);
    }
  }
}
