import * as v from "valibot";
import {
  resource,
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import { accountId, cloudflareCreate } from "src/api/client";
import {
  createApplication,
  deleteApplication,
  getApplication,
  isApplicationNotFound,
  isCreateUnavailable,
  isNamespaceNotContainerEnabled,
  isNamespaceNotVisibleYet,
  isNamespaceTaken,
  listApplications,
  rollOutConfiguration,
  updateApplication,
  type ApplicationSettings,
  type ContainerConfiguration,
  type Json,
  type JsonObject,
} from "src/api/containers";

const jsonSchema: v.GenericSchema<Json> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null(),
    v.array(jsonSchema),
    v.record(v.string(), jsonSchema),
  ]),
);

const jsonObjectSchema: v.GenericSchema<JsonObject> = v.record(
  v.string(),
  jsonSchema,
);

const integerSchema = v.pipe(v.number(), v.integer());

const assignIpSchema = v.picklist(["none", "predefined"]);

// Cloudflare rejects a configuration with a key it doesn't know, so the
// object is strict and a misspelt key fails before the request.
const configurationSchema = v.strictObject({
  image: v.string(),
  instance_type: v.optional(v.string()),
  vcpu: v.optional(v.number()),
  memory: v.optional(v.string()),
  memory_mib: v.optional(v.number()),
  disk: v.optional(jsonObjectSchema),
  environment_variables: v.optional(
    v.array(v.strictObject({ name: v.string(), value: v.string() })),
  ),
  secrets: v.optional(v.array(jsonObjectSchema)),
  labels: v.optional(v.array(jsonObjectSchema)),
  ports: v.optional(v.array(jsonObjectSchema)),
  network: v.optional(
    v.strictObject({
      /** `predefined` makes the container public, and can't be combined with `mode: "private"`. */
      assign_ipv4: v.optional(assignIpSchema),
      assign_ipv6: v.optional(assignIpSchema),
      mode: v.optional(v.picklist(["private", "public"])),
    }),
  ),
  command: v.optional(v.array(v.string())),
  entrypoint: v.optional(v.array(v.string())),
  observability: v.optional(jsonObjectSchema),
  checks: v.optional(v.array(jsonObjectSchema)),
  dns: v.optional(jsonObjectSchema),
  ssh_public_key_ids: v.optional(v.array(v.string())),
});

type Settings = {
  /** The most instances that can run at once. */
  MaxInstances: number;
  /** The image and the resources of each instance. */
  Configuration: ContainerConfiguration;
  Instances?: number;
  /** Seconds that a rollout lets an active instance run before it stops it. */
  RolloutActiveGracePeriod?: number;
  Constraints?: JsonObject;
  Affinities?: JsonObject;
};

export type ContainerApplicationSchema = {
  Key: { AccountId: string; ApplicationId: string };
  CreateParams: Settings & {
    AccountId: string;
    Name: string;
    /** The Durable Object namespace whose objects run the containers. */
    DurableObjectNamespaceId: string;
    Jobs?: boolean;
  };
  UpdateParams: Settings;
  ReadResult: {};
};

const containerApplication = resource<ContainerApplicationSchema>({
  type: "cloudflare/containers/ContainerApplication",
  provider: "@notation/cloudflare/resources",
});

const containerApplicationSchema = containerApplication.defineSchema({
  AccountId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    secondaryKey: true,
    value: v.string(),
  },
  ApplicationId: {
    propertyType: "computed",
    presence: "required",
    primaryKey: true,
    value: v.string(),
  },
  Name: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    value: v.string(),
  },
  DurableObjectNamespaceId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    value: v.string(),
  },
  MaxInstances: {
    propertyType: "param",
    presence: "required",
    value: integerSchema,
  },
  Configuration: {
    propertyType: "param",
    presence: "required",
    value: configurationSchema,
  },
  Instances: {
    propertyType: "param",
    presence: "optional",
    value: integerSchema,
  },
  RolloutActiveGracePeriod: {
    propertyType: "param",
    presence: "optional",
    value: integerSchema,
  },
  Constraints: {
    propertyType: "param",
    presence: "optional",
    value: jsonObjectSchema,
  },
  Affinities: {
    propertyType: "param",
    presence: "optional",
    value: jsonObjectSchema,
  },
  Jobs: {
    propertyType: "param",
    presence: "optional",
    immutable: true,
    value: v.boolean(),
  },
} as const);

type Params = ContainerApplicationSchema["CreateParams"];

const NAMESPACE_RETRY_MS = 5_000;

/**
 * Runs the containers of a Durable Object namespace. The Worker that hosts
 * the namespace must declare the namespace's class as a container class.
 *
 * A change to `Configuration` starts a rollout that replaces every instance.
 * The read doesn't return `Configuration`, `Constraints` or `Affinities`,
 * because Cloudflare fills in defaults for keys that were not set, so a
 * change made outside notation to these values is not seen.
 */
export const ContainerApplication = containerApplicationSchema.defineOperations(
  {
    // Cloudflare refuses a second application for a namespace, so the create
    // can't take over an application that it didn't make.
    create: cloudflareCreate(async (params) => {
      try {
        const application = await createApplication(params.AccountId, {
          name: params.Name,
          durable_objects: { namespace_id: params.DurableObjectNamespaceId },
          configuration: params.Configuration,
          jobs: params.Jobs,
          ...settings(params),
          max_instances: params.MaxInstances,
        });
        return { ApplicationId: application.id };
      } catch (error) {
        throw createError(params, error);
      }
    }),

    // Only one application can use a namespace, so the application with the
    // namespace and the name is the one that the create made.
    find: async (params) => {
      const applications = await listApplications(params.AccountId);
      const application = applications.find(
        (application) =>
          application.name === params.Name &&
          application.durable_objects?.namespace_id ===
            params.DurableObjectNamespaceId,
      );
      if (!application) {
        throw new ResourceNotFoundError(
          `No container application is named ${params.Name} and uses the Durable Object namespace ${params.DurableObjectNamespaceId}`,
        );
      }
      return { ApplicationId: application.id };
    },

    read: async (key) => {
      const application = await getApplication(
        key.AccountId,
        key.ApplicationId,
      );
      if (!application) {
        throw new ResourceNotFoundError("Container application was not found");
      }
      return {
        AccountId: key.AccountId,
        ApplicationId: key.ApplicationId,
        Name: application.name,
        DurableObjectNamespaceId:
          application.durable_objects?.namespace_id ?? undefined,
        MaxInstances: application.max_instances ?? undefined,
        Instances: application.instances ?? undefined,
        RolloutActiveGracePeriod:
          application.rollout_active_grace_period ?? undefined,
      };
    },

    // `PATCH` changes the settings, and a rollout changes the configuration.
    update: async (key, patch, params) => {
      try {
        const changed = settings(patch);
        if (Object.keys(changed).length > 0) {
          await updateApplication(key.AccountId, key.ApplicationId, changed);
        }
        if (patch.Configuration) {
          await rollOutConfiguration(
            key.AccountId,
            key.ApplicationId,
            params.Configuration,
          );
        }
      } catch (error) {
        if (!isApplicationNotFound(error)) throw error;
        throw new Error(
          `The container application ${params.Name} (${key.ApplicationId}) was not found in the Cloudflare account ${key.AccountId}. It may have been deleted outside notation. Deploy again to create it.`,
          { cause: error },
        );
      }
    },

    delete: async (key) => {
      try {
        await deleteApplication(key.AccountId, key.ApplicationId);
      } catch (error) {
        if (!isApplicationNotFound(error)) throw error;
      }
    },

    deriveParams: async () => ({ AccountId: accountId() }),
  },
);

export type ContainerApplicationInstance = InstanceType<
  typeof ContainerApplication
>;

/** Returns the settings that `params` sets, in the request's names. */
function settings(params: Partial<Params>): ApplicationSettings {
  const all: ApplicationSettings = {
    max_instances: params.MaxInstances,
    instances: params.Instances,
    rollout_active_grace_period: params.RolloutActiveGracePeriod,
    constraints: params.Constraints,
    affinities: params.Affinities,
  };
  return Object.fromEntries(
    Object.entries(all).filter(([, value]) => value !== undefined),
  );
}

/**
 * Returns the error that the create throws. Cloudflare refuses some creates
 * for a short time, and nothing is made, so these errors become a
 * `ResourceOperationPendingError` and the reconciler tries again.
 */
function createError(params: Params, error: unknown): unknown {
  const namespace = params.DurableObjectNamespaceId;
  if (isNamespaceNotVisibleYet(error)) {
    return new ResourceOperationPendingError(
      `Cloudflare can't find the Durable Object namespace ${namespace} yet. This lasts a short time after a Worker upload creates the namespace. If it doesn't pass, check that DurableObjectNamespaceId is the ID of a namespace in the account ${params.AccountId}.`,
      { retryAfterMs: NAMESPACE_RETRY_MS, cause: error },
    );
  }
  if (isCreateUnavailable(error)) {
    return new ResourceOperationPendingError(
      `Cloudflare can't create the container application ${params.Name} at this time`,
      { retryAfterMs: NAMESPACE_RETRY_MS, cause: error },
    );
  }
  if (isNamespaceTaken(error)) {
    return new Error(
      `The Durable Object namespace ${namespace} already has a container application, and a namespace can have only one. Delete the other application, or use another namespace.`,
      { cause: error },
    );
  }
  if (isNamespaceNotContainerEnabled(error)) {
    return new Error(
      `The Durable Object namespace ${namespace} can't run containers. Declare its class as a container class in the Worker that hosts it, and deploy the Worker first.`,
      { cause: error },
    );
  }
  return error;
}
