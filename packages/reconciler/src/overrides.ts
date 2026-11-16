import { createHash } from "node:crypto";
import {
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
 * `<id>.<credential>@<instance hash>=<variable>`.
 */
export type CredentialTarget = {
  id: string;
  name: string;
  /** The instance hash of the resource `id`. Optional for plan, and required for deploy. */
  instanceHash?: string;
  /** The environment variable that holds the value. */
  variable: string;
};

/**
 * The user's flags that override what deploy decides from the code: the
 * replaces of `--replace`, and the values of `--credential`.
 */
export type Overrides = {
  replace: ReplaceTarget[];
  /** IDs in `replace` whose class's `rejectChange` deploy skips. */
  overrideLossProtection?: string[];
  credential?: CredentialTarget[];
};

/** How deploy decides a resource that `--replace` names. */
export type ReplaceOverride = { overrideLossProtection: boolean };

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
 * Reads `<id>.<credential>@<instance hash>=<variable>`. The variable is the
 * part after the last `=`. The hash is the part after the last `@` before
 * it, when that part holds no dot. The rest is split at its last dot, so an
 * ID can hold a dot. An uppercase hash is read as lowercase.
 */
export function parseCredentialTarget(value: string): CredentialTarget {
  const equals = value.lastIndexOf("=");
  const variable = value.slice(equals + 1);
  const left = equals < 0 ? value : value.slice(0, equals);
  const at = left.lastIndexOf("@");
  const hasHash = at > left.lastIndexOf(".");
  const target = hasHash ? left.slice(0, at) : left;
  const hash = hasHash ? left.slice(at + 1) : undefined;
  const dot = target.lastIndexOf(".");
  const id = target.slice(0, dot);
  const name = target.slice(dot + 1);
  if (equals < 0 || !variable || dot <= 0 || !name) {
    throw new Error(
      `--credential ${value} is malformed. Give it as <resource id>.<credential>@<instance hash>=<variable>.`,
    );
  }
  if (hash !== undefined && !INSTANCE_HASH.test(hash)) {
    throw new Error(
      `The instance hash ${hash} of ${id} is malformed. An instance hash is 8 hex characters.`,
    );
  }
  return {
    id,
    name,
    ...(hash !== undefined ? { instanceHash: hash.toLowerCase() } : {}),
    variable,
  };
}

/** The `--credential` in the overrides for the credential, if there is one. */
export function findCredentialOverride(
  overrides: Overrides | undefined,
  id: string,
  name: string,
): CredentialTarget | undefined {
  return overrides?.credential?.find(
    (target) => target.id === id && target.name === name,
  );
}

function primaryKeyNames(schema: Schema): string[] {
  return Object.entries(schema)
    .filter(([, item]) => (item as { primaryKey?: true }).primaryKey)
    .map(([name]) => name);
}

/**
 * The overrides as flags, in a fixed order, with each repeated flag once.
 * Empty for no overrides.
 */
export function formatOverrides(overrides: Overrides | undefined): string {
  const flags = [
    ...(overrides?.replace ?? [])
      .map(({ id, instanceHash }) =>
        shellQuote(instanceHash ? `${id}@${instanceHash}` : id),
      )
      .map((value) => `--replace ${value}`)
      .sort(),
    ...(overrides?.overrideLossProtection ?? [])
      .map((id) => `--override-loss-protection ${shellQuote(id)}`)
      .sort(),
    ...(overrides?.credential ?? [])
      .map((target) => `--credential ${shellQuote(formatCredential(target))}`)
      .sort(),
  ];
  return [...new Set(flags)].join(" ");
}

export function formatCredential({
  id,
  name,
  instanceHash,
  variable,
}: CredentialTarget): string {
  return `${id}.${name}${instanceHash === undefined ? "" : `@${instanceHash}`}=${variable}`;
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

/**
 * The overrides with the instance hash of each `--replace` and each
 * `--credential` that leaves it out, from the records in state. Plan prints
 * it in a deploy command, as deploy requires them.
 */
export function withStateIdentifiers(
  overrides: Overrides,
  opts: {
    resources: readonly BaseResource[];
    records: readonly StateNode[];
    deploymentId: string;
  },
): Overrides {
  const record = (id: string) => {
    const found = opts.records.find((node) => node.id === id);
    return found && !isCreatingRecord(found) ? found : undefined;
  };
  const withHash = <T extends { id: string; instanceHash?: string }>(
    target: T,
  ): T => {
    const resource = opts.resources.find(({ id }) => id === target.id);
    const recorded = record(target.id);
    if (target.instanceHash || !resource || !recorded) return target;
    return {
      ...target,
      instanceHash: instanceHash(opts.deploymentId, resource, recorded),
    };
  };
  return {
    ...overrides,
    replace: overrides.replace.map(withHash),
    ...(overrides.credential
      ? { credential: overrides.credential.map(withHash) }
      : {}),
  };
}

/** The options for `decideAction` when the overrides name the resource. */
export function findReplaceOverride(
  overrides: Overrides | undefined,
  id: string,
): ReplaceOverride | undefined {
  if (!overrides?.replace.some((target) => target.id === id)) return undefined;
  return {
    overrideLossProtection: Boolean(
      overrides.overrideLossProtection?.includes(id),
    ),
  };
}

/**
 * Throws if the overrides name a resource that it cannot replace, or gives
 * an instance hash that does not match. Deploy requires each hash, and plan
 * checks a hash when it is given.
 */
export function assertOverrides(
  overrides: Overrides | undefined,
  opts: {
    resources: BaseResource[];
    records: StateNode[];
    deploymentId: string;
    point: "plan" | "deploy";
  },
): void {
  if (!overrides) return;
  const ids = new Set(overrides.replace.map((target) => target.id));
  for (const id of overrides.overrideLossProtection ?? []) {
    if (!ids.has(id)) {
      throw new Error(
        `--override-loss-protection ${id} needs --replace ${id}.`,
      );
    }
  }
  const resourceById = new Map(opts.resources.map((r) => [r.id, r]));
  const recordById = new Map(opts.records.map((node) => [node.id, node]));
  for (const { id, instanceHash: given } of overrides.replace) {
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
    if (isCredentialSource(resource)) {
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
  assertCredentialOverrides(
    overrides,
    resourceById,
    recordById,
    opts.deploymentId,
    opts.point,
  );
}

/**
 * Throws if a `--credential` names `resource`. Deploy calls this when it
 * creates the resource again, and so does plan: the new resource is created
 * with a new value, and deploy would ignore the one that the flag passes.
 */
export function assertNoPassedCredential(
  overrides: Overrides | undefined,
  resource: BaseResource,
): void {
  const target = overrides?.credential?.find(({ id }) => id === resource.id);
  if (!target) return;
  throw new Error(
    `--credential ${target.id}.${target.name} cannot be given when deploy replaces ${target.id}: the replacement is created with a new value.`,
  );
}

/**
 * Throws if a `--credential` names a credential that it cannot set, gives
 * an instance hash that does not match, or names a variable that is not set
 * at deploy.
 */
function assertCredentialOverrides(
  overrides: Overrides,
  resourceById: Map<string, BaseResource>,
  recordById: Map<string, StateNode>,
  deploymentId: string,
  point: "plan" | "deploy",
): void {
  const seen = new Set<string>();
  for (const target of overrides.credential ?? []) {
    const { id, name, instanceHash: given, variable } = target;
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
    if (overrides.replace.some((replaced) => replaced.id === id)) {
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
      // The CLI throws first, with the plan command to run.
      throw new Error(`${flag} has no instance hash.`);
    }
    // The hash ties the flag to the resource of one stage.
    const actual = instanceHash(deploymentId, resource, record);
    if (actual !== given) {
      throw new Error(
        `${id} has the instance hash ${actual} in this stage, not ${given}.`,
      );
    }
    if (point === "deploy" && !process.env[variable]) {
      throw new Error(`${flag} reads ${variable}, which is not set.`);
    }
  }
}
