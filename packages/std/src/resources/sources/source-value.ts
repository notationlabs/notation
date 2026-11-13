import * as v from "valibot";
import { resource } from "@notation/resource";
import { secretContext } from "@notation/core";

type SourceValueParams = {
  Secret: string;
  Source: string;
  Key: string;
  Version: string;
};

export type SourceValueSchema = {
  Key: {};
  CreateParams: SourceValueParams;
  UpdateParams: SourceValueParams;
  ReadResult: {};
};

const sourceValueResource = resource<SourceValueSchema>({
  type: "std/sources/SourceValue",
  provider: "@notation/std/resources",
});

const sourceValueSchema = sourceValueResource.defineSchema({
  /** The id of the secret whose value it is. */
  Secret: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
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
   * The source's version of the key, or the run's ID for a source or key
   * with no version. It is never derived from the value.
   */
  Version: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
} as const);

/**
 * Records where a secret's value comes from: a source and a key. It never
 * holds the value. Its `Version` changes when the source's version of the key
 * changes, or on every run for a source or key with no version, and the secret that
 * depends on it writes its value then.
 *
 * It finds the source in the secret's declaration. Plan and deploy fail when
 * the source doesn't have the key.
 */
export const SourceValue = sourceValueSchema.defineOperations({
  deriveParams: async ({ config }) => {
    const Secret = config.Secret!;
    const Key = config.Key!;
    const context = secretContext();
    if (!context) {
      throw new Error(
        `The source of \`${Secret}\` is read only in notation plan and notation deploy.`,
      );
    }
    const source = context.declared.get(Secret)?.source;
    if (!source) {
      throw new Error(`No secret with a source has the id "${Secret}".`);
    }
    const sourceContext = { stage: context.stage };
    if (!(await source.has(Key, sourceContext))) {
      throw new Error(
        `\`${Key}\` isn't in the ${source.name} source of \`${Secret}\`.`,
      );
    }
    const Version =
      (await source.version?.(Key, sourceContext)) ?? context.runId;
    return { Version };
  },
  create: async () => {},
  update: async () => {},
  delete: async () => {},
});

export type SourceValueInstance = InstanceType<typeof SourceValue>;
