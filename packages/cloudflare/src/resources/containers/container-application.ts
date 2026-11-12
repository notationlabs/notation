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
  NAMESPACE_HAS_APPLICATION,
  NAMESPACE_NOT_CONTAINER_ENABLED,
  rollOutConfiguration,
  updateApplication,
  type ContainerConfiguration,
} from "src/api/containers";
import { listScriptNamespaces } from "src/api/durable-objects";
import {
  WorkerScript,
  type WorkerScriptInstance,
} from "src/resources/workers/worker-script";

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
    /**
     * The `id` of the entry in the Worker's `DurableObjectNamespaces` whose
     * namespace runs the containers. The entry must set `container: true`.
     */
    HostedNamespaceId: string;
    ScriptName: string;
    /** The class of the hosted namespace. */
    ClassName: string;
  };
  UpdateParams: Settings & { ClassName: string };
  ReadResult: {
    /** The Durable Object namespace whose objects run the containers. */
    DurableObjectNamespaceId: string;
  };
};

export type ContainerApplicationDependencies = {
  /** The Worker that hosts the Durable Object namespace. */
  script: WorkerScriptInstance;
};

const containerApplication = resource<ContainerApplicationSchema>({
  type: "cloudflare/containers/ContainerApplication",
  provider: "@notation/cloudflare/resources",
  // A replaced Worker gets new namespaces, and Cloudflare deletes the old
  // ones with the old Worker. The application would be left with a
  // namespace that no longer exists, so deploy deletes it first and creates
  // it again for the new namespace.
  blocksDeleteOf: [WorkerScript.type],
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
  HostedNamespaceId: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    value: v.string(),
  },
  ScriptName: {
    propertyType: "param",
    presence: "required",
    immutable: true,
    value: v.string(),
  },
  // A renamed class keeps its namespace, so the application stays.
  ClassName: {
    propertyType: "param",
    presence: "required",
    value: v.string(),
  },
  DurableObjectNamespaceId: {
    propertyType: "computed",
    presence: "required",
    value: v.string(),
  },
  MaxInstances: {
    propertyType: "param",
    presence: "required",
    value: v.pipe(v.number(), v.integer(), v.minValue(1)),
  },
  Configuration: {
    propertyType: "param",
    presence: "required",
    value: configurationSchema,
  },
} as const);

type Params = ContainerApplicationSchema["CreateParams"];

/**
 * Runs the containers of a Durable Object namespace that a `WorkerScript`
 * hosts. `HostedNamespaceId` picks the namespace from the Worker's
 * `DurableObjectNamespaces`, and that entry must set `container: true`. The
 * Worker is deployed first. The create then looks up the namespace's ID in
 * the namespaces that Cloudflare lists for the Worker.
 *
 * An application that pulls its image from a private registry should
 * `dependOn` the `ContainerRegistry` for that registry.
 *
 * A change to `Configuration` starts a rollout that replaces the instances,
 * 25% of them at a time. Pin the image by its digest: a new image pushed under
 * the same tag doesn't change `Configuration`, so it starts no rollout. The
 * read doesn't return `Configuration`, because Cloudflare fills in defaults
 * for keys that were not set, so a change made outside notation to the
 * configuration is not seen.
 *
 * Cloudflare may merge a rollout's target configuration with the current
 * configuration. If it does, a key that is removed from `Configuration` stays
 * in force, and the read can't show it. This has not been checked against the
 * live API. A deploy soon after another may fail while the earlier rollout
 * is still running.
 */
export const ContainerApplication = containerApplicationSchema
  .defineOperations({
    // Cloudflare refuses a second application for a namespace, so the create
    // can't take over an existing application. `find` can: after a process
    // stop, it adopts the application with the name and the namespace, even
    // if this deploy didn't make it.
    create: async (params) => {
      const namespaceId = await namespaceIdOf(params);
      if (!namespaceId) {
        throw new ResourceOperationPendingError(
          `Cloudflare doesn't list a Durable Object namespace for the class ${params.ClassName} of the Worker ${params.ScriptName} yet. This lasts a short time after a Worker upload creates the namespace.`,
          { retryAfterMs: 5_000 },
        );
      }
      return await cloudflareCreate(async () => {
        try {
          const application = await createApplication(params.AccountId, {
            name: params.Name,
            durable_objects: { namespace_id: namespaceId },
            configuration: params.Configuration,
            max_instances: params.MaxInstances,
          });
          return { ApplicationId: application.id };
        } catch (error) {
          throw createError(params, namespaceId, error);
        }
      })();
    },

    // Only one application can use a namespace, so the application with the
    // namespace and the name is taken to be the one that the create made.
    find: async (params) => {
      const namespaceId = await namespaceIdOf(params);
      const applications = namespaceId
        ? await listApplications(params.AccountId)
        : [];
      const application = applications.find(
        (application) =>
          application.name === params.Name &&
          application.durable_objects?.namespace_id === namespaceId,
      );
      if (!application) {
        throw new ResourceNotFoundError(
          `No container application is named ${params.Name} and uses the Durable Object namespace of the class ${params.ClassName}`,
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
  .requireDependencies<ContainerApplicationDependencies>()
  .deriveParams(async ({ config, deps }) => {
    const script = deps.script.config;
    const hosted = script.DurableObjectNamespaces?.find(
      (namespace) => namespace.id === config.HostedNamespaceId,
    );
    if (!hosted) {
      throw new Error(
        `The Worker ${script.ScriptName} hosts no Durable Object namespace with the id "${config.HostedNamespaceId}". Set HostedNamespaceId to the id of an entry in the Worker's DurableObjectNamespaces.`,
      );
    }
    return {
      AccountId: accountId(),
      ScriptName: script.ScriptName,
      ClassName: hosted.className,
    };
  });

export type ContainerApplicationInstance = InstanceType<
  typeof ContainerApplication
>;

/**
 * Returns the ID of the namespace that Cloudflare lists for the class, or
 * `undefined` if it lists none. A namespace that a Worker upload made may
 * not be listed straight away.
 */
async function namespaceIdOf(params: Params): Promise<string | undefined> {
  const ids = await listScriptNamespaces(params.AccountId, params.ScriptName);
  return ids[params.ClassName];
}

/**
 * Returns the error that the create throws. For a short time after a Worker
 * upload creates a namespace, Cloudflare refuses an application for it, and
 * nothing is made. That error becomes a `ResourceOperationPendingError`, so
 * the reconciler tries again.
 */
function createError(
  params: Params,
  namespace: string,
  error: unknown,
): unknown {
  if (!(error instanceof CloudflareApiError)) return error;
  // This error has no code of its own.
  if (
    error.status === 400 &&
    error.hasMessage(/Durable Object namespace was not found/i)
  ) {
    return new ResourceOperationPendingError(
      `Cloudflare can't find the Durable Object namespace ${namespace} yet. This lasts a short time after a Worker upload creates the namespace.`,
      { retryAfterMs: 5_000, cause: error },
    );
  }
  if (error.hasCode(NAMESPACE_HAS_APPLICATION)) {
    return new Error(
      `The Durable Object namespace ${namespace} already has a container application, and a namespace can have only one. The application may come from an earlier attempt of this deploy. Delete the other application, or use another namespace.`,
      { cause: error },
    );
  }
  if (error.hasCode(NAMESPACE_NOT_CONTAINER_ENABLED)) {
    return new Error(
      `The Durable Object namespace ${namespace} can't run containers. Set \`container: true\` on the entry "${params.HostedNamespaceId}" in the Worker's DurableObjectNamespaces, and deploy again.`,
      { cause: error },
    );
  }
  return error;
}
