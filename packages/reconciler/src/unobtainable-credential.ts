import type { BaseResource } from "@notation/resource";
import type { StateNode } from "@notation/state";
import {
  formatCredential,
  instanceHash,
  shellQuote,
  shortVersion,
} from "./replace-request";

export type UnobtainableCredential = {
  /** The resource that needs the value. */
  consumer: string;
  /** The resource whose credential it is. */
  producer: string;
  producerType: string;
  name: string;
  /** For `--replace`. Unset when plan has no deployment ID. */
  instanceHash?: string;
  /** The version in the producer's record, as `shortVersion` gives it. */
  version: string;
};

/**
 * Plan and deploy throw this when a resource needs the value of a credential
 * without `rotate`, deploy holds none, and neither `--replace` nor
 * `--credential` names the credential. The CLI writes the message again
 * with the command that it ran.
 */
export class UnobtainableCredentialError extends Error {
  readonly _tag = "UnobtainableCredentialError" as const;
  readonly credential: UnobtainableCredential;

  constructor(credential: UnobtainableCredential) {
    super(unobtainableCredentialMessage(credential, "notation deploy"));
    this.name = "UnobtainableCredentialError";
    this.credential = credential;
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
  const passed = formatCredential({
    id: producer,
    name,
    version,
    variable: credentialVariable(producer, name),
  });
  return [
    `${consumer} needs ${producer}.${name}, and deploy cannot get it. ${producerType} issues ${name} once, at create.`,
    "",
    `  Replace ${producer}, to issue a new value:`,
    `    ${deployCommand} --replace ${shellQuote(replace)}`,
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
    version: shortVersion(opts.version),
  };
}

/** A variable name for the plan error, such as `APP_PRIVATE_KEY`. */
export function credentialVariable(id: string, name: string): string {
  return `${id}_${name}`
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}
