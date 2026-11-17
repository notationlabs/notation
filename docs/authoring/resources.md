# Resources

Build custom resource classes with `@notation/resource` to manage internal APIs, SaaS integrations, or cloud services outside first-party provider packages. Each resource class pairs a Standard Schema definition with lifecycle handlers so Notation handles validation, diffing, physical naming, recovery, and cleanup.

Install `@notation/resource` alongside any [Standard Schema V1](https://standardschema.dev) validator such as Valibot:

```sh [Terminal]
@pm.add("@notation/resource")
@pm.add("valibot")
```

## Resource definition

Define a resource class in three chained calls from `defineResource<ApiSchema>(meta)` (`resource` is an alias), then instantiate it in your infrastructure code:

::code-group

```ts [src/webhook-endpoint.ts]
import * as v from "valibot";
import { defineResource, mergeContributions, ResourceNotFoundError } from "@notation/resource";

type WebhookApi = {
  Key: { accountId: string; endpointId: string };
  CreateParams: { accountId: string; name: string; url: string; headers?: Record<string, string> };
  UpdateParams: { url: string; headers?: Record<string, string> };
  ReadResult: { status: "active" | "disabled" };
};

export const WebhookEndpoint = defineResource<WebhookApi>({
  type: "acme/webhooks/WebhookEndpoint",
  provider: "@acme/webhooks/resources",
})
  .defineSchema({
    accountId: { propertyType: "param", presence: "required", immutable: true, secondaryKey: true, value: v.string() },
    endpointId: { propertyType: "computed", presence: "required", primaryKey: true, value: v.string() },
    name: { propertyType: "param", presence: "required", immutable: true, value: v.string(), physicalName: { maxLength: 64 } },
    url: { propertyType: "param", presence: "required", value: v.pipe(v.string(), v.url()) },
    headers: { propertyType: "param", presence: "optional", value: v.record(v.string(), v.string()), collect: mergeContributions },
    status: { propertyType: "computed", presence: "required", value: v.picklist(["active", "disabled"]) },
    signingSecret: { propertyType: "credential", value: v.string() },
  } as const)
  .defineOperations({
    create: async (params) => webhookClient.createEndpoint(params),
    read: async (key) => {
      const ep = await webhookClient.getEndpoint(key.accountId, key.endpointId);
      if (!ep) throw new ResourceNotFoundError("Webhook endpoint was not found");
      return { ...key, name: ep.name, url: ep.url, headers: ep.headers, status: ep.status };
    },
    update: async (key, _patch, params) => { await webhookClient.updateEndpoint(key.accountId, key.endpointId, params); },
    delete: async (key) => { await webhookClient.deleteEndpoint(key.accountId, key.endpointId); },
  });

export type WebhookEndpointInstance = InstanceType<typeof WebhookEndpoint>;
```

```ts [infra/orders.ts]
import { WebhookEndpoint } from "../src/webhook-endpoint";

export const ordersWebhook = new WebhookEndpoint("orders-webhook", {
  config: {
    accountId: "acct_orders",
    url: "https://orders.example.com/webhooks",
  },
});
```

::

Keep three rules in mind when defining your schema and metadata:

- **Use an importable `provider` specifier** – Orphan cleanup imports the resource class from `provider` after it leaves your application code, so never use a relative path.
- **Pass `as const` to standalone schemas** – TypeScript needs literal inference on `propertyType`, `presence`, `primaryKey`, and `immutable` so `SchemaFromApi` and instance types stay exact.
- **Keep validators pure and durable** – Notation validates with `StandardSchemaV1<T, T>` without applying transforms or defaults, and rejects non-serializable types such as functions or `Buffer`.

## Scoped physical names

`WebhookEndpoint` attaches `physicalName: { maxLength: 64 }` to `name`, so `ordersWebhook` omits `name` from `config`. At deploy time, Notation generates a stage-scoped name (`<app>--<stage>--orders-webhook-<instance>`), replaces the resource create-first when `name` changes, and lets dependents read it via `ordersWebhook.outputRef("name")`.

Customize the base segment or required suffix (such as `.fifo` on SQS queues) with `base` and `ending` on `PhysicalNameRule`:

```ts [src/queue-schema.ts]
import * as v from "valibot";
import type { PhysicalNameRule } from "@notation/resource";

const queueNameRule: PhysicalNameRule = {
  maxLength: 80,
  base: (resourceId) => resourceId.replace(/^sqs-queue:/, ""),
  ending: (params) => (params.fifo === true ? ".fifo" : ""),
};

export const queueNameSchema = {
  propertyType: "param",
  presence: "required",
  immutable: true,
  value: v.string(),
  physicalName: queueNameRule,
} as const;
```

## Asynchronous polling

When provisioning takes longer than a single request, throw `ResourceOperationPendingError` with `retryAfterMs` and durable `callbackContext` so the reconciler resumes polling from where it stopped:

```ts [src/pending-example.ts]
import { ResourceOperationPendingError, type ResourceOperationContext } from "@notation/resource";

async function createWithPolling(params: { name: string }, context?: ResourceOperationContext) {
  const jobId = (context?.jobId as string | undefined) ?? (await startJob(params.name));
  const status = await pollJob(jobId);
  if (status === "running") {
    throw new ResourceOperationPendingError("Waiting for endpoint provisioning", {
      retryAfterMs: 2_000,
      callbackContext: { jobId },
    });
  }
  return { endpointId: status.endpointId };
}
```

Use `ResourceNotFoundError`, `ResourceAlreadyExistsError`, and `ResourceCreationUnknownError` to signal missing resources, takeover collisions, and uncertain timeouts.

## Loss protection

Add `rejectChange` to `.defineOperations(...)` to block destructive replacements or orphan deletions when a resource is removed from code:

```ts [src/bucket-guards.ts]
import type { RejectChange } from "@notation/resource";

export const refuseDeleteOrReplace: RejectChange<{ name: string; lockRetention?: boolean }> = (
  previous,
  desired,
  context,
) => {
  if (desired === undefined && previous.lockRetention) {
    return "Cannot delete a retention-locked bucket while removing it from code.";
  }
  if (context.requested) {
    return "Replacing this bucket deletes stored objects.";
  }
  return undefined;
};
```

For single-field replacement rules, attach `rejectReplace(previous, desired)` directly on the param schema item. Operators can bypass `rejectChange` during an explicit `--replace` with `--override-loss-protection <id>`.

## Derived parameters

When a downstream resource needs to compute its own parameters from another resource's outputs, chain `.requireDependencies<Deps>().deriveParams(...)` onto the resource class:

```ts [src/webhook-subscription.ts]
import * as v from "valibot";
import { defineResource } from "@notation/resource";
import type { WebhookEndpointInstance } from "./webhook-endpoint";

type SubscriptionApi = {
  Key: { endpointId: string };
  CreateParams: { endpointId: string; targetUrl: string };
  UpdateParams: { targetUrl: string };
  ReadResult: {};
};

const BaseSubscription = defineResource<SubscriptionApi>({
  type: "acme/webhooks/Subscription",
  provider: "@acme/webhooks/resources",
})
  .defineSchema({
    endpointId: { propertyType: "param", presence: "required", immutable: true, primaryKey: true, value: v.string() },
    targetUrl: { propertyType: "param", presence: "required", value: v.string() },
  } as const)
  .defineOperations({
    create: async (params) => void params,
    update: async () => undefined,
    delete: async () => undefined,
  });

export const WebhookSubscription = BaseSubscription
  .requireDependencies<{ endpoint: WebhookEndpointInstance }>()
  .deriveParams(({ deps }) => ({
    endpointId: deps.endpoint.output.endpointId,
    targetUrl: `${deps.endpoint.output.url}?primary=true`,
  }));
```

During `plan`, reading any unresolved output inside `deriveParams` marks all derived fields on that resource as unknown until apply. When you only need to pass a single output straight through without transforming it, pass `resource.outputRef(key)` in `config` instead so all other params remain exact during `plan`.

## Contributions

Adding `collect` to a `"param"` schema item – such as `collect: mergeContributions` on `WebhookEndpoint.headers` – makes the field optional in `config` and lets other modules call `resource.contribute(values)` during evaluation:

```ts [infra/orders-headers.ts]
import { text } from "@notation/resource";
import { ordersWebhook } from "./orders";

ordersWebhook.contribute({
  headers: {
    "x-service": "orders",
    "x-endpoint": text`${ordersWebhook.outputRef("name")}`,
  },
});
```

Use `mergeContributions` for plain-object maps, or write a custom `collect(items, context)` function for list-based params such as policy statements:

```ts [src/policy-collect.ts]
import * as v from "valibot";
import type { CollectContext } from "@notation/resource";

export const policySchema = {
  propertyType: "param",
  presence: "required",
  value: v.object({
    Version: v.string(),
    Statement: v.array(v.object({ Effect: v.string(), Action: v.array(v.string()), Resource: v.string() })),
  }),
  collect: (items: Array<{ Statement?: Array<{ Effect: string; Action: string[]; Resource: string }> }>, _context: CollectContext) => ({
    Version: "2012-10-17",
    Statement: items.flatMap((item) => item.Statement ?? []),
  }),
} as const;
```

Always pass values to `contribute(values)` using `` text`...` ``, `ref.map()`, and `all()` rather than the deprecated `contribute(fn, { deps })` form. Use `resource.dependOn(other)` for ordering without refs, and `resource["~state"].outputRef(key)` inside `contribute()` to break cycles with prior state outputs.

## Resource groups

Extend `ResourceGroup` to bundle `WebhookEndpoint` and `WebhookSubscription` behind one construct and deduplicate shared child resources with `this.addOnce(...)`:

```ts [src/order-webhook-group.ts]
import { ResourceGroup } from "@notation/resource";
import { WebhookEndpoint } from "./webhook-endpoint";
import { WebhookSubscription } from "./webhook-subscription";

export class OrderWebhookGroup extends ResourceGroup<{ accountId: string; url: string }> {
  readonly endpoint: InstanceType<typeof WebhookEndpoint>;

  constructor(id: string, config: { accountId: string; url: string }) {
    super("acme/webhooks/OrderWebhook", id, config);

    this.endpoint = this.add(
      new WebhookEndpoint(`${id}:endpoint`, {
        config: { accountId: config.accountId, url: config.url },
      }),
    );

    this.addOnce(WebhookSubscription, `${id}:subscription`, {
      dependencies: { endpoint: this.endpoint },
    });
  }
}
```

Every resource or child group added through `this.add(...)` or `this.addOnce(...)` can belong to only one group, and group `id` values must be unique within each group `type`.
