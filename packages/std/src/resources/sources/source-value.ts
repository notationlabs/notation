import * as v from "valibot";
import { resource } from "@notation/resource";
import { secretContext, type Source } from "@notation/core";

export type SourceValueSchema = {
  Key: {};
  CreateParams: { Source: string; Key: string; Version: string };
  UpdateParams: { Source: string; Key: string; Version: string };
  ReadResult: {};
};

const sourceValueResource = resource<SourceValueSchema>({
  type: "std/sources/SourceValue",
  provider: "@notation/std/resources",
});

const sourceValueSchema = sourceValueResource.defineSchema({
  /** The source's name, such as `infisical`. */
  Source: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  /** The key that the source is asked for. */
  Key: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  /**
   * The source's version of the key, or the run's ID for a source with no
   * versions. It is never derived from the value.
   */
  Version: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
} as const);

const SourceValueResource = sourceValueSchema.defineOperations<{
  Version: string;
}>({
  create: async () => {},
  update: async () => {},
  delete: async () => {},
});

type SourceValueResourceInstance = InstanceType<typeof SourceValueResource>;

// The class that `defineOperations` returns is typed as the abstract
// `Resource`, which a class can't extend. Its instances implement every
// member, so it is typed here as a plain constructor.
const SourceValueBase = SourceValueResource as unknown as {
  new (
    id: string,
    opts: { config: { Source: string; Key: string } },
  ): Pick<SourceValueResourceInstance, keyof SourceValueResourceInstance>;
} & Pick<typeof SourceValueResource, keyof typeof SourceValueResource>;

export type SourceValueOptions = {
  config: { Source: string; Key: string };
  /** The source that the declaration was given. */
  source?: Source;
  /** The id of the secret whose value it is, for error messages. */
  secret?: string;
};

/**
 * Records where a secret's value comes from: a source and a key. It never
 * holds the value. Its `Version` changes when the source's version of the key
 * changes, or on every run for a source with no versions, and the secret that
 * depends on it writes its value then.
 *
 * Plan and deploy fail when the source doesn't have the key.
 */
export class SourceValue extends SourceValueBase {
  readonly #source: Source | undefined;
  readonly #secret: string;

  constructor(id: string, options: SourceValueOptions) {
    super(id, { config: options.config });
    this.#source = options.source;
    this.#secret = options.secret ?? id;
  }

  deriveParams = async (): Promise<{ Version: string }> => {
    const source = this.#source;
    const { Key } = this.config;
    if (!source) {
      throw new Error(`${this.id} has no source, so its params can't be read.`);
    }
    const context = secretContext();
    if (!context) {
      throw new Error(
        `${this.id} reads its source only in notation plan and notation deploy.`,
      );
    }
    const sourceContext = { stage: context.stage };
    if (!(await source.has(Key, sourceContext))) {
      throw new Error(
        `\`${Key}\` isn't in the ${source.name} source of \`${this.#secret}\`.`,
      );
    }
    const Version = source.version
      ? await source.version(Key, sourceContext)
      : context.runId;
    return { Version };
  };
}

export type SourceValueInstance = InstanceType<typeof SourceValue>;
