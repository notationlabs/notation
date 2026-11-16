import type {
  ResolveSchema,
  Schema,
  SchemaFromApi,
  SchemaItem,
} from "./resource.schema";
import {
  Resource,
  type BaseResource,
  type ConfigParams,
  type InferResourceTypes,
  type ResourceArgs,
  type ResourceType,
  type ResourceTypes,
} from "./resource";
import type { NoInfer } from "./types";

export type DefineCredentialSourceApiSchema = {
  /** The params that config sets. */
  Params: any;
  /** The type of the value that `loadCredential` returns. */
  Value: any;
};

/** What a source's operations are told about the deploy or plan. */
export type CredentialSourceContext = {
  /** The ID of the source. */
  id: string;
  /**
   * The ID of the deploy's execution, which a resumed deploy keeps. Each
   * plan has an ID of its own.
   */
  executionId: string;
  app: string;
  stage: string;
};

export type CredentialSourceReadContext<State = any> =
  CredentialSourceContext & {
    /**
     * The outputs in the source's record, without its credential. Undefined
     * when the source has no record.
     */
    state: State | undefined;
    /** Shows a warning for the source in the output of plan and deploy. */
    warn(message: string): void;
  };

/** The outputs that `read` returns: every computed property, with `revision`. */
export type CredentialSourceReadResult<T extends ResourceTypes> = Omit<
  T["state"],
  keyof T["params"]
>;

export type CredentialSourceOperations<T extends ResourceTypes> = {
  /**
   * Returns the source's `revision`, and never the value. It may read the
   * value to work the revision out. Plan and deploy call it for every
   * source. A new revision gives the credential a new version, and every
   * resource that takes the credential is updated.
   */
  read: (
    params: T["params"],
    context: CredentialSourceReadContext<T["state"]>,
  ) => Promise<CredentialSourceReadResult<T>>;
  /**
   * Returns the value for the revision in `state`, and the same value each
   * time for the same revision, unless the revision names no fixed value,
   * as for an Infisical secret with a reference. `state` holds the params and the outputs
   * that `read` returned. Deploy calls it only when a resource that takes the
   * value is created or updated, and deploy holds no value.
   */
  loadCredential: (
    state: T["state"],
    context: CredentialSourceContext,
  ) => Promise<T["credentials"]["value"]>;
};

export interface BaseCredentialSource extends BaseResource {
  readonly kind: "credential-source";
  /** See `CredentialSourceOperations.read`. */
  readSource(
    params: any,
    context: CredentialSourceReadContext,
  ): Promise<Record<string, unknown>>;
  /** See `CredentialSourceOperations.loadCredential`. */
  loadCredential(
    state: any,
    context: CredentialSourceContext,
  ): Promise<unknown>;
}

export function isCredentialSource(
  resource: Pick<BaseResource, "kind">,
): resource is BaseCredentialSource {
  return resource.kind === "credential-source";
}

/**
 * The base class of a source. Deploy never creates, updates or replaces a
 * source. When a source leaves the code, deploy deletes its record and calls
 * nothing.
 */
export abstract class CredentialSource<
  T extends ResourceTypes = ResourceTypes,
  C extends Record<string, any> = T["params"],
> extends Resource<T, {}, C> {
  override readonly kind = "credential-source" as const;
  abstract readSource: CredentialSourceOperations<T>["read"];
  abstract loadCredential: CredentialSourceOperations<T>["loadCredential"];
  read = undefined;
  update = undefined;
  create = async (): Promise<never> => {
    throw new Error(`${this.id} is a source, and deploy never creates one`);
  };
  delete = async (): Promise<void> => {};

  deriveParams(): Record<string, any> {
    return {};
  }
}

export type CredentialSourceClass<
  T extends ResourceTypes,
  C extends Record<string, any> = ConfigParams<T>,
> = {
  new (id: string, ...args: ResourceArgs<C, {}>): CredentialSource<T, C>;
  readonly type: ResourceType;
  readonly provider: string;
  readonly blocksDeleteOf: readonly ResourceType[];
};

/**
 * The schema of a source: its params, a computed `revision`, any other
 * computed outputs, and one credential, `value`.
 */
type CredentialSourceSchema<Api extends DefineCredentialSourceApiSchema> =
  Schema &
    SchemaFromApi<{}, Api["Params"], Api["Params"], { revision: string }> & {
      value: SchemaItem<Api["Value"]> & { propertyType: "credential" };
    };

export type CredentialSourceBuilder<
  Api extends DefineCredentialSourceApiSchema,
> = {
  defineSchema: <S extends CredentialSourceSchema<Api>>(
    schema: S,
  ) => {
    defineOperations: (
      opts: CredentialSourceOperations<InferResourceTypes<ResolveSchema<S>>>,
    ) => CredentialSourceClass<InferResourceTypes<ResolveSchema<S>>>;
  };
};

/**
 * Builds the class of a source: a value that exists outside notation, such
 * as an environment variable. Nothing is created at a provider. The source
 * has one credential, `value`, which another resource takes through
 * `source.credentials.value`.
 *
 * The credential's version is made from the source's params and its
 * `revision`, so a change to either updates every resource that takes it.
 */
export function credentialSourceResource<
  Api extends DefineCredentialSourceApiSchema,
>(meta: {
  type: ResourceType;
  provider: string;
}): CredentialSourceBuilder<Api> {
  return {
    defineSchema(schema) {
      // Deploy loads only `value`, with `loadCredential`.
      const others = Object.entries(schema as Schema)
        .filter(
          ([name, item]) =>
            item.propertyType === "credential" && name !== "value",
        )
        .map(([name]) => name);
      if (others.length > 0) {
        throw new Error(
          `${meta.type} is a source, and has one credential, value. Its schema also declares ${others.join(", ")}.`,
        );
      }
      return {
        defineOperations(opts) {
          type T = InferResourceTypes<ResolveSchema<typeof schema>>;
          class SimpleCredentialSource<
            C extends Record<string, any> = ConfigParams<T>,
          > extends CredentialSource<T, NoInfer<C>> {
            static type = meta.type;
            static provider = meta.provider;
            static blocksDeleteOf: readonly ResourceType[] = [];
            type = meta.type;
            provider = meta.provider;
            schema = schema;
            readSource = opts.read;
            loadCredential = opts.loadCredential;

            constructor(id: string, args?: { config?: NoInfer<C> }) {
              super(id, args);
              this.checkDeclaration();
            }
          }
          return SimpleCredentialSource as any;
        },
      };
    },
  };
}
