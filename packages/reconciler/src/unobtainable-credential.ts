import type { BaseResource } from "@notation/resource";
import type { StateNode } from "@notation/state";
import { credentialsToMint, credentialVersion } from "./credentials";
import {
  formatCredential,
  formatRequest,
  instanceHash,
  requestedCredential,
  shellQuote,
  shortVersion,
  type DeployRequest,
} from "./deploy-request";

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
 * with the flags of `request`. The CLI throws a new error with the
 * `--config` and `--stage` of the command that it ran.
 */
export class UnobtainableCredentialError extends Error {
  readonly _tag = "UnobtainableCredentialError" as const;
  readonly credential: UnobtainableCredential;
  /**
   * The request of the plan or deploy, with an instance hash for each
   * `--replace` and a version for each `--credential` that state has.
   */
  readonly request?: DeployRequest;

  constructor(
    credential: UnobtainableCredential,
    request?: DeployRequest,
    deployCommand = "notation deploy",
  ) {
    super(
      unobtainableCredentialMessage(
        credential,
        [deployCommand, formatRequest(request)].filter(Boolean).join(" "),
      ),
    );
    this.name = "UnobtainableCredentialError";
    this.credential = credential;
    if (request) this.request = request;
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
 * each that `--credential` names, and each that `credentialsToMint` lists.
 * Throws for a credential in that list without `rotate`. Plan and deploy's
 * validate step call this for a resource that deploy keeps, and whose
 * record is not "creating".
 */
export function mintedCredentials(opts: {
  producer: BaseResource;
  record: StateNode;
  consumers: readonly { resource: BaseResource; record?: StateNode }[];
  requested: DeployRequest | undefined;
  deploymentId: string | undefined;
}): string[] {
  const { producer, record, requested, deploymentId } = opts;
  const minted = (requested?.credential ?? [])
    .filter((target) => target.id === producer.id)
    .map((target) => target.name);
  const needed = credentialsToMint(producer, record.output, opts.consumers);
  for (const { name, consumer } of needed) {
    if (minted.includes(name)) continue;
    if (!producer.rotate?.[name]) {
      throw new UnobtainableCredentialError(
        unobtainableCredential({
          consumer,
          producer,
          name,
          record,
          version: credentialVersion(producer, name),
          deploymentId,
        }),
        requested,
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
  requested: DeployRequest | undefined;
  deploymentId: string | undefined;
}): boolean {
  const { producer, name } = opts;
  if (producer.rotate?.[name]) return true;
  if (requestedCredential(opts.requested, producer.id, name)) return false;
  throw new UnobtainableCredentialError(
    unobtainableCredential({
      ...opts,
      version: credentialVersion(producer, name),
    }),
    opts.requested,
  );
}

/** A variable name for the plan error, such as `APP_PRIVATE_KEY`. */
export function credentialVariable(id: string, name: string): string {
  return `${id}_${name}`
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}
