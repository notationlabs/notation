import { declareSecret, PROMPT_SOURCE } from "@notation/core";
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
import { assertSecretId } from "src/secrets-store/store";
import type { WorkerSecretDeclaration } from "./declaration";

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
  workerId: string;
  /** The Worker's generated name without its instance, from `workerNames`. */
  nameBody: string;
  name: string;
};

export class WorkerSecretGroup
  extends ResourceGroup<WorkerSecretConfig>
  implements WorkerSecretDeclaration
{
  platform = "cloudflare";
  readonly "~workerSecret" = true as const;
  /** Records the source and key of a secret that has a source. */
  readonly value?: std.sources.SourceValueInstance;
  readonly #boundBy: BoundBy[] = [];

  constructor(config: WorkerSecretConfig) {
    const { id, source, key } = config;
    assertSecretId("workerSecret()", id);
    if (source && typeof key !== "string") {
      throw new Error(
        `workerSecret({ id: "${id}" }) has a source but no key. Give the key that the source is asked for.`,
      );
    }
    super("cloudflare/workerSecret", id, config);
    if (source) {
      this.value = this.add(
        new std.sources.SourceValue(`value:${id}`, {
          config: { Secret: id, Source: source.name, Key: key! },
        }),
      );
    }
    declareSecret({
      id,
      source,
      key,
      set: async (value) => {
        const account = accountId();
        const targets = await this.#targets(account);
        const missing = targets.filter(({ scripts }) => scripts.length === 0);
        if (missing.length > 0) {
          const workers = [...new Set(missing.map((t) => t.workerId))];
          throw new Error(
            `\`${id}\` is a Worker secret, and the Worker ${workers.map((w) => `"${w}"`).join(", ")} that binds it isn't deployed. Run \`notation deploy\` instead: it asks for the value when it creates the secret.`,
          );
        }
        for (const { name, scripts } of targets) {
          for (const script of scripts) {
            await putScriptSecret(account, script, name, value);
          }
        }
      },
      delete: async () => {
        const account = accountId();
        for (const { name, scripts } of await this.#targets(account)) {
          for (const script of scripts) {
            await deleteScriptSecret(account, script, name);
          }
        }
      },
    });
  }

  /**
   * The Workers in the account that bind the secret, found by name. The
   * commands don't read state, so a Worker's name, which has a random
   * instance, is matched against its name body.
   */
  async #targets(account: string) {
    if (this.#boundBy.length === 0) {
      throw new Error(
        `No Worker binds the Worker secret \`${this.config.id}\`, so there is nowhere to write it.`,
      );
    }
    const names = await listScriptNames(account);
    return this.#boundBy.map((bound) => ({
      ...bound,
      scripts: names.filter((name) => matchesWorkerNames(name, bound)),
    }));
  }

  /** Where the value comes from. It never holds the value. */
  valueFrom(): SecretValueFrom {
    const { id, source, key } = this.config;
    return this.value
      ? {
          Secret: id,
          Source: source!.name,
          Key: key!,
          Version: this.value.outputRef("Version") as string,
        }
      : { Secret: id, Source: PROMPT_SOURCE };
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
