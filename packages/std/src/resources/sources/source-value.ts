import * as v from "valibot";
import { requireExecutionContext } from "@notation/core";
import {
  Resource,
  type InferResourceTypes,
  type ResolveSchema,
  type ResourceType,
} from "@notation/resource";
import type { Source } from "src/sources/types";

export const sourceValueSchema = {
  Source: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  Key: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  Version: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
} as const;

type SourceValueTypes = InferResourceTypes<
  ResolveSchema<typeof sourceValueSchema>
>;

export type SourceValueArgs = {
  config: { Source: string; Key: string };
  dependencies?: {};
  source?: Source;
};

/**
 * Records a reference to where a secret's value comes from (`Source`, `Key`,
 * and computed `Version`), without ever storing the secret's value.
 */
export class SourceValue extends Resource<
  SourceValueTypes,
  {},
  { Source: string; Key: string }
> {
  static readonly type: ResourceType = "std/sources/SourceValue";
  static readonly provider = "@notation/std/resources";
  static readonly blocksDeleteOf: readonly ResourceType[] = [];

  readonly type: ResourceType = SourceValue.type;
  readonly provider = SourceValue.provider;
  readonly deleteTakesDependents = false;
  readonly alwaysRead = true;
  readonly schema = sourceValueSchema;

  #source?: Source;

  constructor(id: string, args: SourceValueArgs) {
    super(id, args);
    this.#source = args?.source;
    this.checkDeclaration();
  }

  deriveParams = async (): Promise<{}> => {
    const { secretId, source, key } = this.#resolveSource();
    const { stage } = requireExecutionContext();
    await this.#assertHas(source, key, stage, secretId);
    return {};
  };

  read = async (): Promise<{ Version: string }> => {
    const { secretId, source, key } = this.#resolveSource();
    const { stage, executionId } = requireExecutionContext();
    await this.#assertHas(source, key, stage, secretId);
    const Version = source.version
      ? await source.version(key, { stage })
      : executionId;
    return { Version };
  };

  create = async (): Promise<void> => {};
  update = async (): Promise<void> => {};
  delete = async (): Promise<void> => {};

  async #assertHas(
    source: Source,
    key: string,
    stage: string,
    secretId: string,
  ): Promise<void> {
    if (!(await source.has(key, { stage }))) {
      throw new Error(
        `${key} isn't in the ${source.name} source of ${secretId}.`,
      );
    }
  }

  #resolveSource(): { secretId: string; source: Source; key: string } {
    const secretId = this.id.startsWith("value:")
      ? this.id.slice("value:".length)
      : this.id;
    const source = this.#source;
    if (!source) {
      throw new Error(`No source provided for ${this.id}.`);
    }
    return {
      secretId,
      source,
      key: this.config.Key,
    };
  }
}

export type SourceValueInstance = SourceValue;
