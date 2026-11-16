import type { BaseResource, RecordedOutputs } from "@notation/resource";
import type { StateNode } from "@notation/state";
import { isCreatingRecord } from "@notation/state";
import {
  getConsumerNeed,
  getCredentialsToMint,
  type CredentialNeed,
} from "./credentials";
import {
  formatCredential,
  formatOverrides,
  instanceHash,
  findCredentialOverride,
  shellQuote,
  type Overrides,
} from "./overrides";

export type UnobtainableCredential = {
  /** The resource that needs the value. */
  consumer: string;
  /** The resource whose credential it is. */
  producer: string;
  producerType: string;
  name: string;
  /** Why the consumer needs the value now. */
  reason: CredentialNeed;
  /** The producer's `rotateManually` sentence for the credential. */
  rotateManually?: string;
  /**
   * The producer's instance hash, for `--credential` and `--replace`. Unset
   * when plan has no deployment ID, or the producer has no record.
   */
  instanceHash?: string;
};

/**
 * Plan and deploy throw this when a resource needs the value of a credential
 * without `rotate`, deploy holds none, and neither `--replace` nor
 * `--credential` names the credential. Plan and deploy's validate step list
 * every such credential. The message gives deploy commands with the flags of
 * `overrides`. The CLI throws a new error with the `--config` and `--stage`
 * of the command that it ran.
 */
export class UnobtainableCredentialError extends Error {
  readonly _tag = "UnobtainableCredentialError" as const;
  readonly credentials: readonly UnobtainableCredential[];
  /**
   * The overrides of the plan or deploy, with an instance hash for each
   * `--replace` and `--credential` whose resource has a record.
   */
  readonly overrides?: Overrides;

  constructor(
    credentials: readonly UnobtainableCredential[],
    overrides?: Overrides,
    deployCommand = "notation deploy",
    options?: ErrorOptions,
  ) {
    super(
      unobtainableCredentialMessage(
        credentials,
        [deployCommand, formatOverrides(overrides)].filter(Boolean).join(" "),
      ),
      options,
    );
    this.name = "UnobtainableCredentialError";
    this.credentials = credentials;
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

/**
 * Throws an UnobtainableCredentialError for the credentials, if there are
 * any. A credential that several resources need is listed once, with the
 * first of them.
 */
export function throwIfUnobtainable(
  credentials: readonly UnobtainableCredential[],
  overrides: Overrides | undefined,
): void {
  if (credentials.length === 0) return;
  const unique = new Map<string, UnobtainableCredential>();
  for (const credential of credentials) {
    const key = `${credential.producer}.${credential.name}`;
    if (!unique.has(key)) unique.set(key, credential);
  }
  throw new UnobtainableCredentialError([...unique.values()], overrides);
}

/**
 * For one credential, two deploy commands. For several, the lines of each
 * credential with its two flags, and then the deploy command once, as the
 * user adds one flag for each.
 */
export function unobtainableCredentialMessage(
  credentials: readonly UnobtainableCredential[],
  deployCommand: string,
): string {
  if (credentials.length === 1) {
    return credentialLines(credentials[0]!, `${deployCommand} `).join("\n");
  }
  return [
    `${credentials.length} credentials need a new value before deploy can run. Each is listed below with two flags. Choose one flag for each.`,
    ...credentials.flatMap((credential) => [
      "",
      ...credentialLines(credential, ""),
    ]),
    "",
    "Then run deploy with the flags that you chose:",
    `  ${deployCommand} <flags>`,
  ].join("\n");
}

const needs: Record<CredentialNeed, (c: Names) => string> = {
  "no-version": (c) =>
    `${c.consumer} takes ${c.credential}, and state has no record of a value for it.`,
  "consumer-added": (c) => `${c.consumer} is new, and takes ${c.credential}.`,
  "consumer-create-unfinished": (c) =>
    `An earlier deploy did not finish the create of ${c.consumer}, which takes ${c.credential}.`,
  "consumer-replaced": (c) =>
    `Deploy replaces ${c.consumer}, which takes ${c.credential}.`,
  "consumer-behind": (c) =>
    `${c.consumer} takes ${c.credential}, and has not received its current value.`,
  "not-held": (c) =>
    `${c.consumer} takes ${c.credential}, and the deploy run that received its value has ended.`,
};

/** The names in the message, each in backticks. */
type Names = { consumer: string; credential: string };

const quoted = (name: string) => `\`${name}\``;

/** The lines for one credential, with `prefix` before each flag. */
function credentialLines(
  credential: UnobtainableCredential,
  prefix: string,
): string[] {
  const { producer, name } = credential;
  const variable = credentialVariable(producer, name);
  const passed = formatCredential({
    id: producer,
    name,
    instanceHash: credential.instanceHash,
    variable,
  });
  const replace = credential.instanceHash
    ? `${producer}@${credential.instanceHash}`
    : producer;
  const type = quoted(credential.producerType);
  const resource = quoted(producer);
  const need = needs[credential.reason]({
    consumer: quoted(credential.consumer),
    credential: quoted(`${producer}.${name}`),
  });
  const issue =
    credential.rotateManually ??
    `Issue a new value of ${quoted(name)} at the provider of ${type}.`;
  return [
    credential.reason === "no-version"
      ? `${need} ${type} has no operation that issues one.`
      : `${need} Notation does not store the value, and ${type} has no operation that issues another.`,
    "",
    `  ${issue} Then set the environment variable ${quoted(variable)} to the value, and pass it:`,
    `    ${prefix}--credential ${shellQuote(passed)}`,
    "",
    `  Or replace ${resource}. Deploy deletes ${resource} and creates it again with a new value, so whatever exists only in the old ${resource} is lost:`,
    `    ${prefix}--replace ${shellQuote(replace)}`,
  ];
}

export function unobtainableCredential(opts: {
  consumer: BaseResource;
  producer: BaseResource;
  name: string;
  reason: CredentialNeed;
  /** The producer's record. */
  record: StateNode | undefined;
  deploymentId?: string;
}): UnobtainableCredential {
  const { consumer, producer, name, reason, record, deploymentId } = opts;
  const rotateManually = producer.rotateManually?.[name];
  return {
    consumer: consumer.id,
    producer: producer.id,
    producerType: producer.type,
    name,
    reason,
    ...(rotateManually ? { rotateManually } : {}),
    ...(deploymentId && record && !isCreatingRecord(record)
      ? { instanceHash: instanceHash(deploymentId, producer, record) }
      : {}),
  };
}

/**
 * The credentials of `producer` that deploy gives a new value before it
 * reaches the resources that take them, as `mintNeededCredentials` does:
 * each that `--credential` names, and each that `getCredentialsToMint` lists.
 * A credential in that list without `rotate` is added to `unobtainable`, and
 * counted as one that `--credential` names, so the caller goes on to find
 * the others. Plan and deploy's validate step call this for a resource that
 * deploy keeps, and whose record is not "creating".
 */
export async function mintedCredentials(opts: {
  producer: BaseResource;
  record: StateNode;
  consumers: readonly { resource: BaseResource; record?: StateNode }[];
  recordedOutputs: RecordedOutputs;
  overrides: Overrides | undefined;
  deploymentId: string | undefined;
  unobtainable: UnobtainableCredential[];
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
  for (const { name, consumer, reason } of needed) {
    if (minted.includes(name)) continue;
    if (!producer.rotate?.[name]) {
      opts.unobtainable.push(
        unobtainableCredential({
          consumer,
          producer,
          name,
          reason,
          record,
          deploymentId,
        }),
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
 * names. Any other credential without `rotate` is added to `unobtainable`,
 * and counted as one that `--credential` names.
 */
export function rotatesForCreate(opts: {
  consumer: BaseResource;
  /** The consumer's record, which gives the reason in the error. */
  consumerRecord: StateNode | undefined;
  producer: BaseResource;
  name: string;
  /** The producer's record. */
  record: StateNode | undefined;
  overrides: Overrides | undefined;
  deploymentId: string | undefined;
  unobtainable: UnobtainableCredential[];
}): boolean {
  const { producer, name, consumerRecord } = opts;
  if (producer.rotate?.[name]) return true;
  if (findCredentialOverride(opts.overrides, producer.id, name)) return false;
  opts.unobtainable.push(
    unobtainableCredential({
      ...opts,
      reason: getConsumerNeed(consumerRecord) ?? "consumer-replaced",
    }),
  );
  return false;
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
