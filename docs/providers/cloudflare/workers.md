# Workers

`@notation/cloudflare/workers` declares Cloudflare Workers and Durable Object namespaces. A Worker is declared with `$worker` in a runtime module, next to its code, and Notation builds the code for workerd.

## `$worker(config)`

A [runtime module](../../manual/file-conventions.md#runtime-modules) calls `$worker` to declare the Worker that it deploys as. The module has a default export, written with Cloudflare's own API:

```ts [runtime/api.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";

export const worker = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ GREETING: "hello" }),
});

export default {
  async fetch(request, env) {
    return new Response(
      `${env.GREETING} from ${new URL(request.url).pathname}`,
    );
  },
} satisfies WorkerHandler<typeof worker>;
```

When infra has finished loading, the declaration adds a Worker group with:

- the **Worker script** `api`, named `<app>--<stage>--api`, which uploads the bundle `dist/runtime/api/index.mjs`,
- the **workers.dev route** of the Worker, unless `url` is `false`.

The declaration adds the Worker even when nothing imports it.

| Option               | Description                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | Names the Worker and keys it in state. Use 1 to 63 lowercase letters, digits or hyphens. Changing the id replaces the Worker.                            |
| `name`               | The Worker's name in Cloudflare, in place of the id. The Worker is named `<app>--<stage>--<name>`. Changing the name replaces the Worker.                |
| `bindings`           | A function that returns the values that the code reads from `env`, by name. See [Bindings](#bindings).                                                   |
| `compatibilityDate`  | Required. The Worker's compatibility date, such as `"2026-10-12"`. Cloudflare runs the Worker with the behaviour of the runtime on that date.            |
| `compatibilityFlags` | The Worker's compatibility flags. `nodejs_compat` is always added, as the build imports Node's built-in modules as `node:` modules, which need the flag. |
| `url`                | Serves the Worker on `https://<name>.<account subdomain>.workers.dev`. Defaults to `true`, as in wrangler.                                               |

### Bindings

`bindings` returns an object literal with no spread or computed keys. The runtime build keeps the names and removes the values. Each value is bound by its type:

| Value                                                     | Binding                  | Type in `env`                   |
| --------------------------------------------------------- | ------------------------ | ------------------------------- |
| A namespace from [`$durableObject`](#durableobjectconfig) | Durable Object namespace | `DurableObjectNamespace<Class>` |
| A Worker from `$worker`                                   | Service binding          | `Fetcher`                       |
| A string                                                  | Plain text               | `string`                        |

`WorkerEnv<typeof worker>` is the type of `env`, and `WorkerHandler<typeof worker>` is the type of the default export. A Worker that binds another Worker is uploaded after it.

Two Workers can bind each other as services. Each service binding is a [contribution](../../reference/resource.md#cycles) to the Worker's script, so deploy can break the cycle:

1. Deploy uploads one of the Workers without its service bindings.
2. It uploads the other Worker, which binds the first.
3. It uploads the first Worker again, with its service bindings.

Between steps 1 and 3, the first Worker's `env` has no service bindings, so a request that calls the other Worker fails.

### Deleting a Worker that other Workers bind

Cloudflare doesn't delete a Worker that another Worker binds as a service, or whose Durable Object namespace another Worker binds, unless the delete is forced. Deploy deletes a Worker when its `name` changes, when it is removed from code, and in destroy.

- When every Worker that binds it is in the same app and stage, the delete is forced. After a change of `name`, deploy uploads each of those Workers again with the new name. Their bindings are broken from the delete until that upload, so requests that use them fail in between.
- When another Worker binds it, such as a Worker of another app or stage, or one that Notation did not deploy, the delete fails, and the error names that Worker. A Pages project that binds the Worker, and a Worker that sends it tail events, stop the delete in the same way. Remove the reference first.

Deleting a Worker deletes the objects of the Durable Object namespaces that it hosts, forced or not.

Namespaces can't close a cycle. When two Workers each bind a namespace that the other hosts, plan fails, as each Worker is uploaded after the host of each namespace that it binds.

## `$durableObject(config)`

A runtime module calls `$durableObject` to declare a Durable Object namespace. The module holds only this declaration and the class. A Worker hosts the namespace when it binds the namespace and its module exports the class:

::code-group

```ts [runtime/counter.ts]
import { DurableObject } from "cloudflare:workers";
import { $durableObject } from "@notation/cloudflare/workers";

export class Counter extends DurableObject {
  async increment() {
    const count = ((await this.ctx.storage.get<number>("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return count;
  }
}

export const counters = $durableObject({ id: "counters", class: Counter });
```

```ts [runtime/api.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { counters } from "./counter";
export { Counter } from "./counter";

export const worker = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ COUNTERS: counters }),
});

export default {
  async fetch(request, env) {
    const count = await env.COUNTERS.getByName("one").increment();
    return new Response(`count=${count}`);
  },
} satisfies WorkerHandler<typeof worker>;
```

::

| Option    | Description                                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`      | Keys the namespace. Use 1 to 64 letters, digits, hyphens or underscores. It can't change while the namespace exists: see [Renaming and deleting](#renaming-and-deleting).                                                       |
| `class`   | The namespace's class, by name, such as `class: Counter`. Cloudflare finds the class by its export name, so the hosting Worker exports the class under the name written here.                                                   |
| `protect` | Defaults to `true`. Plan fails for a change that would delete a protected namespace. Plan reads the value from state, so `protect: false` takes effect after it is deployed. See [Deleting a namespace](#deleting-a-namespace). |

The infra build doesn't load the class, or its imports such as `cloudflare:workers`. It replaces the class with a function of the same name.

### Hosting

Exactly one of the Workers that bind a namespace exports its class, and that Worker hosts the namespace. Every other Worker that binds the namespace binds it on the hosting Worker, and is uploaded after it. Plan fails when:

- no Worker that binds the namespace exports the class. The error names the Worker's module. A class re-exported with `export * from` is not found, because the bundle doesn't re-export the names of `export *`.
- two Workers that bind the namespace export the class.
- one Worker hosts two namespaces with the same class.

The host is found by the export's name only. A Worker that binds the namespace and exports a different class under the same name, such as another `Counter`, is taken as the host.

### Renaming and deleting

A new namespace uses SQLite storage. Deploy uploads Cloudflare's declarative `exports` map of the hosting Worker, with each namespace that the Worker hosted before. Cloudflare keys a namespace by its Worker and its class name, and deleting a namespace deletes all its objects, which can't be undone. So plan and deploy fail, before deploy changes anything, for a change that would delete a namespace that is protected in state:

- When a namespace's `class` changes and its `id` stays the same, deploy renames the class, and the namespace keeps its objects.
- A namespace's `id` can't change. Plan fails, and says to change the id back. This holds when the `class` changes too.
- When the hosting Worker no longer hosts a namespace, plan fails, unless the namespace is unprotected in state. See [Deleting a namespace](#deleting-a-namespace).
- A namespace can't move to another Worker. When the class export moves to the module of another Worker that binds the namespace, plan fails for the old host. Export the class from the old host again.
- When a Worker is removed or replaced, as when its `id` or `name` changes, deploy deletes all its namespaces. Plan fails unless each of them is unprotected in state.
- Plan fails if a namespace takes a class that another namespace had on the same Worker before, as the new namespace would get the old one's objects. Rename or delete the old namespace in one deploy, and give its class to the new namespace in a later deploy.

`notation destroy` doesn't make these checks. It deletes each Worker with its namespaces.

### Deleting a namespace

Deleting a namespace takes two deploys. First set `protect: false` on its declaration, and deploy while the Worker still hosts the namespace:

```ts [runtime/rooms.ts]
export const rooms = $durableObject({
  id: "rooms",
  class: Room,
  protect: false,
});
```

This deploy saves the value in the state of the hosting Worker. It doesn't upload the Worker again or change the namespace. Plan lists the Worker as unchanged, with `UnprotectedDurableObjects changes in state only`.

In a later deploy, remove the declaration, its binding and its class. Deploy uploads a `deleted` entry for the namespace's class. The Worker's module must no longer export the class, or Cloudflare rejects the upload. In the same way, a later deploy can remove the hosting Worker, or change its `id` or `name`, once all its namespaces are unprotected in state.

Plan reads `protect` from state, not from code. A deploy that sets `protect: false` and also stops hosting the namespace fails at plan.

## Credentials

Deploy reads two environment variables:

- `CLOUDFLARE_API_TOKEN`: an API token with the **Workers Scripts: Edit** permission.
- `CLOUDFLARE_ACCOUNT_ID`: the account to deploy to. It is stored in state, so a later deploy updates or deletes each Worker in the account it was made in.

A Worker can't move to another account. If `CLOUDFLARE_ACCOUNT_ID` changes, plan and deploy fail, because replacing each Worker would delete the objects of the namespaces that it hosts. To deploy to another account, first run `notation destroy` with the old account, or deploy to another stage.

A Worker that exists already in the account, with the same name, is not taken over. The create fails.
