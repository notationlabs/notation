import { declareSecret } from "@notation/core";
import { ResourceGroup } from "@notation/resource";
import * as std from "@notation/std/resources";
import type { Source } from "@notation/std/sources";
import { accountId } from "src/api/client";
import {
  deleteScriptSecret,
  listScriptNames,
  putScriptSecret,
} from "src/api/workers";
import { matchesWorkerNames } from "src/id";
import type { SecretValueFrom } from "src/resources/secrets-store/secrets-store-secret";
import { addSecretValue, assertSecretId } from "src/secrets-store/store";
import type { WorkerSecret } from "./declaration";

export type WorkerSecretConfig = {
  /**
   * Keys the secret in state, and is what `notation secret set <id>` takes.
   * It must differ from the id of every other secret.
   */
  id: string;
} & (
  | {
      /**
       * Where the value comes from, such as `env` or `dotenv(".env.local")`
       * from `@notation/std/sources`. Without a source, deploy asks for the
       * value when it creates the secret, and `notation secret set` sets it.
       */
      source: Source;
      /** The key that the source is asked for. */
      key: string;
    }
  | { source?: undefined; key?: undefined }
);

/** A Worker that binds the secret, and the name of the binding. */
type BoundBy = {
  /** The Worker's generated name without its instance, from `workerNames`. */
  nameBody: string;
  name: string;
};

export class WorkerSecretGroup
  extends ResourceGroup<WorkerSecretConfig>
  implements WorkerSecret
{
  platform = "cloudflare";
  readonly "~workerSecret" = true as const;
  /** Records the source and key of a secret that has a source. */
  readonly value?: std.sources.SourceValueInstance;
  /** Where the value comes from. It never holds the value. */
  readonly valueFrom: SecretValueFrom;
  readonly #boundBy: BoundBy[] = [];

  constructor(config: WorkerSecretConfig) {
    const { id, source, key } = config;
    assertSecretId("workerSecret()", id);
    super("cloudflare/workerSecret", id, config);
    const { value, valueFrom } = addSecretValue(
      this,
      `workerSecret({ id: "${id}" })`,
      config,
    );
    this.value = value;
    this.valueFrom = valueFrom;
    declareSecret({
      id,
      source,
      key,
      set: async (secret) => {
        const account = accountId();
        for (const { script, name } of await this.#targets(account)) {
          await putScriptSecret(account, script, name, secret);
        }
      },
      delete: async () => {
        const account = accountId();
        for (const { script, name } of await this.#targets(account)) {
          await deleteScriptSecret(account, script, name);
        }
      },
    });
  }

  /**
   * The deployed Workers that bind the secret, with the binding's name. The
   * commands don't read state, so a Worker's name, which has a random
   * instance, is matched against its name body. Throws if there are none.
   */
  async #targets(account: string) {
    const names = await listScriptNames(account);
    const targets = this.#boundBy.flatMap((bound) =>
      names
        .filter((script) => matchesWorkerNames(script, bound))
        .map((script) => ({ script, name: bound.name })),
    );
    if (targets.length === 0) {
      throw new Error(
        `No deployed Worker binds the Worker secret \`${this.config.id}\`. Run \`notation deploy\` first.`,
      );
    }
    return targets;
  }

  /** Records that a Worker binds the secret, for `notation secret set`. */
  boundBy(bound: BoundBy): void {
    this.#boundBy.push(bound);
  }
}

export const isWorkerSecret = (value: unknown): value is WorkerSecretGroup =>
  typeof value === "object" && value !== null && "~workerSecret" in value;

/**
 * Declares a secret that a Worker binds as a `secret_text` binding. In the
 * Worker, the binding is a string. Each Worker that binds it has its own
 * copy of the secret, which deploy writes with Cloudflare's secrets API for
 * the Worker. Deploy writes the value from `source`, or asks for it when
 * there is no source. Notation records where the value comes from, and
 * never the value.
 * @resource
 */
export function workerSecret(config: WorkerSecretConfig): WorkerSecretGroup {
  return new WorkerSecretGroup(config);
}
