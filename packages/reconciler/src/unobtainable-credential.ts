import type { BaseResource, RecordedOutputs } from "@notation/resource";
import type { StateNode } from "@notation/state";
import { getCredentialsToMint, getCredentialVersion } from "./credentials";
import {
  formatCredential,
  formatOverrides,
  instanceHash,
  findCredentialOverride,
  shellQuote,
  shortVersion,
  type Overrides,
} from "./overrides";

export type UnobtainableCredential = {
  /** The resource that needs the value. */
  consumer: string;
  /** The resource whose credential it is. */
  producer: string;
  producerType: string;
  name: string;
  /** For `--replace`. Unset when plan has no deployment ID. */
  instanceHash?: string;
  /**
   * The version in the producer's record, as `shortVersion` gives it. Unset
   * when the record has none, as `--credential` then cannot be given.
   */
  version?: string;
};

/**
 * Plan and deploy throw this when a resource needs the value of a credential
 * without `rotate`, deploy holds none, and neither `--replace` nor
 * `--credential` names the credential. The message gives deploy commands
 * with the flags of `overrides`. The CLI throws a new error with the
 * `--config` and `--stage` of the command that it ran.
 */
export class UnobtainableCredentialError extends Error {
  readonly _tag = "UnobtainableCredentialError" as const;
  readonly credential: UnobtainableCredential;
  /**
   * The overrides of the plan or deploy, with an instance hash for each
   * `--replace` and a version for each `--credential` that state has.
   */
  readonly overrides?: Overrides;

  constructor(
    credential: UnobtainableCredential,
    overrides?: Overrides,
    deployCommand = "notation deploy",
    options?: ErrorOptions,
  ) {
    super(
      unobtainableCredentialMessage(
        credential,
        [deployCommand, formatOverrides(overrides)].filter(Boolean).join(" "),
      ),
      options,
    );
    this.name = "UnobtainableCredentialError";
    this.credential = credential;
    if (overrides) this.overrides = overrides;
  }

  static is(error: unknown): error is UnobtainableCredentialError {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as { _tag?: unknown })._tag === "UnobtainableCredentialError"
    );
  }
}

export function unobtainableCredentialMessage(
  credential: UnobtainableCredential,
  deployCommand: string,
): string {
  const { consumer, producer, producerType, name, version } = credential;
  const replace = credential.instanceHash
    ? `${producer}@${credential.instanceHash}`
    : producer;
  const lines = [
    `${consumer} needs ${producer}.${name}, and deploy cannot get it. ${producerType} issues ${name} once, at create.`,
    "",
    `  Replace ${producer}, to issue a new value:`,
    `    ${deployCommand} --replace ${shellQuote(replace)}`,
  ];
  if (version === undefined) return lines.join("\n");
  const passed = formatCredential({
    id: producer,
    name,
    version,
    variable: credentialVariable(producer, name),
  });
  return [
    ...lines,
    "",
    "  Or pass a value that you hold:",
    `    ${deployCommand} --credential ${shellQuote(passed)}`,
  ].join("\n");
}

export function unobtainableCredential(opts: {
  consumer: BaseResource;
  producer: BaseResource;
  name: string;
  record: StateNode | undefined;
  version: string | null;
  deploymentId?: string;
}): UnobtainableCredential {
  const { consumer, producer, name, record, deploymentId } = opts;
  return {
    consumer: consumer.id,
    producer: producer.id,
    producerType: producer.type,
    name,
    ...(deploymentId && record
      ? { instanceHash: instanceHash(deploymentId, producer, record) }
      : {}),
    ...(opts.version !== null ? { version: shortVersion(opts.version) } : {}),
  };
}

/**
 * The credentials of `producer` that deploy gives a new value before it
 * reaches the resources that take them, as `mintNeededCredentials` does:
 * each that `--credential` names, and each that `getCredentialsToMint` lists.
 * Throws for a credential in that list without `rotate`. Plan and deploy's
 * validate step call this for a resource that deploy keeps, and whose
 * record is not "creating".
 */
export async function mintedCredentials(opts: {
  producer: BaseResource;
  record: StateNode;
  consumers: readonly { resource: BaseResource; record?: StateNode }[];
  recordedOutputs: RecordedOutputs;
  overrides: Overrides | undefined;
  deploymentId: string | undefined;
}): Promise<string[]> {
  const { producer, record, overrides, deploymentId } = opts;
  const minted = (overrides?.credential ?? [])
    .filter((target) => target.id === producer.id)
    .map((target) => target.name);
  const needed = await getCredentialsToMint(
    producer,
    record.output,
    opts.consumers,
    opts.recordedOutputs,
  );
  for (const { name, consumer } of needed) {
    if (minted.includes(name)) continue;
    if (!producer.rotate?.[name]) {
      throw new UnobtainableCredentialError(
        unobtainableCredential({
          consumer,
          producer,
          name,
          record,
          version: getCredentialVersion(producer, name),
          deploymentId,
        }),
        overrides,
      );
    }
    minted.push(name);
  }
  return minted;
}

/**
 * Whether deploy rotates a credential that `consumer` takes when deploy
 * creates `consumer` again and holds no value for it, as
 * `obtainCredentials` does. False for a credential that `--credential`
 * names. Throws for any other credential without `rotate`.
 */
export function rotatesForCreate(opts: {
  consumer: BaseResource;
  producer: BaseResource;
  name: string;
  record: StateNode | undefined;
  overrides: Overrides | undefined;
  deploymentId: string | undefined;
}): boolean {
  const { producer, name } = opts;
  if (producer.rotate?.[name]) return true;
  if (findCredentialOverride(opts.overrides, producer.id, name)) return false;
  throw new UnobtainableCredentialError(
    unobtainableCredential({
      ...opts,
      version: getCredentialVersion(producer, name),
    }),
    opts.overrides,
  );
}

/** A variable name for the plan error, such as `APP_PRIVATE_KEY`. */
export function credentialVariable(id: string, name: string): string {
  const variable = `${id}_${name}`
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  // A shell variable name cannot start with a digit.
  return /^[0-9]/.test(variable) ? `_${variable}` : variable;
}
