import { declareSecret } from "@notation/core";
import { ResourceGroup } from "@notation/resource";
import * as std from "@notation/std/resources";
import type { Source } from "@notation/std/sources";
import type { SecretBinding } from "src/resources/workers/worker-script";
import { assertSecretId } from "src/secrets-store/store";
import type { WorkerSecret } from "./declaration";

export type WorkerSecretConfig = {
  /**
   * Keys the secret's source value in state, with the ID `value:<id>`. It
   * must differ from the id of every other secret.
   */
  id: string;
  /** Where the value comes from, such as `env` or `dotenv(".env.local")`. */
  source: Source;
  /** The key that the source is asked for. */
  key: string;
};

export class WorkerSecretGroup
  extends ResourceGroup<WorkerSecretConfig>
  implements WorkerSecret
{
  platform = "cloudflare";
  readonly "~workerSecret" = true as const;
  /** Records the source and key, and the source's version of the key. */
  readonly value: std.sources.SourceValueInstance;

  constructor(config: WorkerSecretConfig) {
    assertSecretId("workerSecret()", config.id);
    if (!config.source || typeof config.key !== "string") {
      throw new Error(
        `workerSecret({ id: "${config.id}" }) requires a source and a key. Deploy reads the value from the source each time it uploads a Worker that binds the secret.`,
      );
    }
    super("cloudflare/workerSecret", config.id, config);
    const { id, source, key } = config;
    this.value = this.add(
      new std.sources.SourceValue(`value:${id}`, {
        config: { Secret: id, Source: source.name, Key: key },
      }),
    );
    declareSecret({
      id,
      source,
      key,
      refusal: `\`${id}\` is a Worker secret. Deploy reads its value from the ${source.name} source each time it uploads a Worker that binds it, so change the value in the source.`,
    });
  }

  /** The binding of the secret as `name`, which holds no value. */
  binding(name: string): SecretBinding {
    const { id, source, key } = this.config;
    return {
      Name: name,
      ValueFrom: {
        Secret: id,
        Source: source.name,
        Key: key,
        Version: this.value.outputRef("Version") as string,
      },
    };
  }
}

/**
 * Declares a secret that a Worker binds as a `secret_text` binding. In the
 * Worker, the binding is a string. Deploy reads the value from `source` when
 * it uploads the Worker, and uploads the Worker again when the source's
 * version of the key changes. Notation records the source and key, and never
 * the value.
 * @resource
 */
export function workerSecret(config: WorkerSecretConfig): WorkerSecretGroup {
  return new WorkerSecretGroup(config);
}
