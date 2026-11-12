import * as v from "valibot";
import {
  resource,
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import {
  accountId,
  CloudflareApiError,
  cloudflareCreate,
} from "src/api/client";
import {
  configurationSchema,
  createApplication,
  deleteApplication,
  getApplication,
  isApplicationNotFound,
  listApplications,
  rollOutConfiguration,
  updateApplication,
  type ContainerConfiguration,
} from "src/api/containers";

type Settings = {
  /** The most instances that can run at once. */
  MaxInstances: number;
  /** The image and the resources of each instance. */
  Configuration: ContainerConfiguration;
};

export type ContainerApplicationSchema = {
  Key: { AccountId: string; ApplicationId: string };
  CreateParams: Settings & {
    AccountId: string;
    Name: string;
    /** The Durable Object namespace whose objects run the containers. */
    DurableObjectNamespaceId: string;
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
    value: v.pipe(v.number(), v.integer()),
  },
  Configuration: {
    propertyType: "param",
    presence: "required",
    value: configurationSchema,
  },
} as const);

type Params = ContainerApplicationSchema["CreateParams"];

/**
 * Runs the containers of a Durable Object namespace. The Worker that hosts
 * the namespace must declare the namespace's class as a container class.
 *
 * A change to `Configuration` starts a rollout that replaces every instance.
 * The read doesn't return `Configuration`, because Cloudflare fills in
 * defaults for keys that were not set, so a change made outside notation to
 * the configuration is not seen.
 */
export const ContainerApplication = containerApplicationSchema
  .defineOperations({
    // Cloudflare refuses a second application for a namespace, so the create
    // can't take over an application that it didn't make.
    create: cloudflareCreate(async (params) => {
      try {
        const application = await createApplication(params.AccountId, {
          name: params.Name,
          durable_objects: { namespace_id: params.DurableObjectNamespaceId },
          configuration: params.Configuration,
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
      };
    },

    // `PATCH` changes `MaxInstances`, and a rollout changes the configuration.
    update: async (key, patch) => {
      if (patch.MaxInstances !== undefined) {
        await updateApplication(key.AccountId, key.ApplicationId, {
          max_instances: patch.MaxInstances,
        });
      }
      if (patch.Configuration) {
        await rollOutConfiguration(
          key.AccountId,
          key.ApplicationId,
          patch.Configuration,
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
  })
  .requireDependencies<{}>()
  .deriveParams(async () => ({ AccountId: accountId() }));

export type ContainerApplicationInstance = InstanceType<
  typeof ContainerApplication
>;

/**
 * Returns the error that the create throws. For a short time after a Worker
 * upload creates a namespace, Cloudflare refuses an application for it, and
 * nothing is made. That error becomes a `ResourceOperationPendingError`, so
 * the reconciler tries again.
 */
function createError(params: Params, error: unknown): unknown {
  if (!(error instanceof CloudflareApiError)) return error;
  const namespace = params.DurableObjectNamespaceId;
  // This error has no code of its own.
  if (
    error.status === 400 &&
    error.hasMessage(/Durable Object namespace was not found/i)
  ) {
    return new ResourceOperationPendingError(
      `Cloudflare can't find the Durable Object namespace ${namespace} yet. This lasts a short time after a Worker upload creates the namespace. If it doesn't pass, check that DurableObjectNamespaceId is the ID of a namespace in the account ${params.AccountId}.`,
      { retryAfterMs: 5_000, cause: error },
    );
  }
  if (error.hasCode(1608)) {
    return new Error(
      `The Durable Object namespace ${namespace} already has a container application, and a namespace can have only one. Delete the other application, or use another namespace.`,
      { cause: error },
    );
  }
  if (error.hasCode(1607)) {
    return new Error(
      `The Durable Object namespace ${namespace} can't run containers. Declare its class as a container class in the Worker that hosts it, and deploy the Worker first.`,
      { cause: error },
    );
  }
  return error;
}
