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

- the **Worker script** `api`, which uploads the bundle `dist/runtime/api/index.mjs`. Deploy names it `<app>--<stage>--api-<instance>` when it creates it. See [Names](#names).
- the **workers.dev route** of the Worker, unless `url` is `false`.

The declaration adds the Worker even when nothing imports it.

| Option               | Description                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | Keys the Worker in state, and is the base of its name. Use 1 to 63 lowercase letters, digits or hyphens. Changing the id replaces the Worker.            |
| `bindings`           | A function that returns the values that the code reads from `env`, by name. See [Bindings](#bindings).                                                   |
| `compatibilityDate`  | Required. The Worker's compatibility date, such as `"2026-10-12"`. Cloudflare runs the Worker with the behaviour of the runtime on that date.            |
| `compatibilityFlags` | The Worker's compatibility flags. `nodejs_compat` is always added, as the build imports Node's built-in modules as `node:` modules, which need the flag. |
| `url`                | Serves the Worker on `https://<name>.<account subdomain>.workers.dev`, where `<name>` is the Worker's name. Defaults to `true`, as in wrangler.          |

### Names

Deploy generates a Worker's name when it creates the Worker: `<app>--<stage>--<id>-<instance>`, where the instance is 8 random hex characters. A Worker `orders` in the `prod` stage of the `shop` app is named, for example, `shop--prod--orders-3f9a1c2e`. The name can't be set in config.

- **The longest name is 54 characters.** A Worker's name is the first label of its workers.dev URL, and a DNS label holds 63 characters. A preview URL puts a version prefix of 8 characters and a hyphen in the same label. Cloudflare refuses to serve a Worker with a longer name on workers.dev while its preview URLs are on, and turning on workers.dev turns them on. When the name would be longer, the part before the instance is cut short.
- **The name is not known before the first deploy.** Plan shows the name of a Worker that deploy creates as unknown, and so its workers.dev URL. Anything outside Notation that needs the URL must read it after the first deploy.
- **The name does not change after that.** Deploy keeps the name in the Worker's state record, and uses it on each later deploy. Only a replace would change it, and the only change that replaces a Worker, a change of the account, fails at plan.
- **Deploy fills in the name wherever the Worker is bound.** A service binding to the Worker, a Durable Object binding to a namespace that it hosts, and a binding of the Worker to itself all hold the generated name. A Worker that binds itself is created once, with the binding.
- **A new Worker with the id of an old one is a second Worker.** This happens when the state record of a Worker is lost. The old Worker stays in the account.

### Bindings

`bindings` returns an object literal with no spread or computed keys. The runtime build keeps the names and removes the values. Each value is bound by its type:

| Value                                                     | Binding                  | Type in `env`                   |
| --------------------------------------------------------- | ------------------------ | ------------------------------- |
| A namespace from [`$durableObject`](#durableobjectconfig) | Durable Object namespace | `DurableObjectNamespace<Class>` |
| A Worker from `$worker`                                   | Service binding          | `Fetcher`                       |
| A secret from [`secretsStore.bind`](secrets.md)           | Secrets Store secret     | `SecretsStoreSecret`            |
| A secret from [`workerSecret`](#workersecretconfig)       | Secret text              | `string`                        |
| An `R2Bucket` resource                                    | R2 bucket                | `R2Bucket`                      |
| A `KVNamespace` resource                                  | KV namespace             | `KVNamespace`                   |
| A value from `json(value)`                                | JSON                     | the type of `value`             |
| A string                                                  | Plain text               | `string`                        |

`WorkerEnv<typeof worker>` is the type of `env`, and `WorkerHandler<typeof worker>` is the type of the default export. A Worker that binds another Worker, an R2 bucket or a KV namespace is uploaded after it.

An infra module declares the R2 bucket, the KV namespace and the Worker secret, and the runtime module imports them. `R2Bucket` and `KVNamespace` are resources from `@notation/cloudflare/resources`:

::code-group

```ts [infra/main.ts]
import { kv, r2 } from "@notation/cloudflare/resources";
import { workerSecret } from "@notation/cloudflare/workers";
import { env } from "@notation/std/sources";

export const uploads = new r2.R2Bucket("uploads", {
  config: {
    BucketName: "shop-uploads",
    Jurisdiction: "default",
    StorageClass: "Standard",
  },
});

export const cache = new kv.KVNamespace("cache", {
  config: { Title: "shop-cache" },
});

export const apiKey = workerSecret({
  id: "api-key",
  source: env,
  key: "API_KEY",
});
```

```ts [runtime/api.ts]
import {
  $worker,
  json,
  type WorkerHandler,
} from "@notation/cloudflare/workers";
import { apiKey, cache, uploads } from "../infra/main";

export const worker = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({
    UPLOADS: uploads,
    CACHE: cache,
    CONFIG: json({ retries: 3 }),
    API_KEY: apiKey,
  }),
});

export default {
  async fetch(request, env) {
    await env.CACHE.put("last", new Date().toISOString());
    const object = await env.UPLOADS.get("logo.png");
    return new Response(object?.body ?? null, {
      headers: { "x-retries": String(env.CONFIG.retries) },
    });
  },
} satisfies WorkerHandler<typeof worker>;
```

::

- A binding to a bucket in a jurisdiction other than `default` names the jurisdiction.
- `json(value)` takes a JSON value. Deploy stores the value in state, and plan shows it. Bind a secret with `workerSecret` instead.

Two Workers can bind each other as services. Each service binding is a [contribution](../../reference/resource.md#cycles) to the Worker's script, so deploy can break the cycle:

1. Deploy uploads one of the Workers without its service bindings.
2. It uploads the other Worker, which binds the first.
3. It uploads the first Worker again, with its service bindings.

Between steps 1 and 3, the first Worker's `env` has no service bindings, so a request that calls the other Worker fails.

### `workerSecret(config)`

`workerSecret` declares a secret that a Worker binds as secret text. In the Worker, the binding is a string. The value comes from a [source](../../manual/secrets.md#sources), or from the [prompt](../../manual/secrets.md#the-prompt) when there is no source. Cloudflare stores the value with the Worker, not in a Secrets Store.

| Option   | Description                                                                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`     | Keys the secret in state, and is what `notation secret set <id>` takes. It must differ from the id of every other secret.                                                        |
| `source` | Where the value comes from, such as `env` or `dotenv(".env.local")` from `@notation/std/sources`. Without a source, deploy asks for the value, or `notation secret set` sets it. |
| `key`    | The key that the source is asked for. Required with `source`.                                                                                                                    |

```ts [infra/main.ts]
import { workerSecret } from "@notation/cloudflare/workers";

// No source: deploy asks for the value, or `notation secret set admin-password` sets it.
export const adminPassword = workerSecret({ id: "admin-password" });
```

Each Worker that binds the secret has its own copy of it. Deploy adds a `cloudflare/workers/WorkerSecret` resource, with the ID `worker:<worker id>:secret:<binding name>`, for each binding. The resource sets the secret with Cloudflare's secrets API for the Worker, after the Worker is uploaded.

- Notation records the binding's name, the source, the key and the source's version of the key. It never records the value.
- An upload of the Worker keeps its secrets, so an upload never needs a secret's value. A change to the Worker's code or bindings doesn't write its secrets.
- A secret with a source is written when the source's version of the key changes. For `env` and `dotenv`, that is every deploy. Each write deploys a new version of the Worker.
- A secret without a source is written only when the Worker doesn't have it. Deploy asks for the value then, or fails without a terminal. A value set with `notation secret set`, or given at an earlier prompt, is kept.
- When a Worker stops binding the secret, deploy deletes the secret from the Worker. When the Worker is replaced, the new Worker has none of the old Worker's secrets, so deploy writes them again, and asks for each one that has no source.
- On a Worker's first deploy, the Worker is uploaded before its secrets are set. For a short time, its secrets are missing from `env`.
- An upload also keeps a secret that wasn't set by Notation, such as one set with `wrangler secret put`. A binding in `bindings` with the name of such a secret replaces it.
- A value changed in the dashboard or with wrangler stays until deploy next writes the secret.

`notation secret set <id>` writes the value to each Worker in the stage that binds the secret. It doesn't read state, so it finds each Worker in the account by the name that deploy gives it, `<app>--<stage>--<id>-` followed by 8 hex characters. It fails, and writes nothing, when one of those Workers isn't deployed yet: run `notation deploy` instead, which asks for the value. `notation secret delete <id>` deletes the secret from each of those Workers. The next deploy writes it again.

### Deleting a Worker that other Workers bind

Cloudflare doesn't delete a Worker that another Worker binds as a service, or whose Durable Object namespace another Worker binds, unless the delete is forced. Deploy deletes a Worker when its `id` changes, when it is removed from code, and in destroy.

- When every Worker that binds it is in the same app and stage, the delete is forced.
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
| `id`      | Keys the namespace. Use 1 to 64 letters, digits, hyphens or underscores. It can't change while the namespace exists: see [Renaming, moving and deleting](#renaming-moving-and-deleting).                                        |
| `class`   | The namespace's class, by name, such as `class: Counter`. Cloudflare finds the class by its export name, so the hosting Worker exports the class under the name written here.                                                   |
| `protect` | Defaults to `true`. Plan fails for a change that would delete a protected namespace. Plan reads the value from state, so `protect: false` takes effect after it is deployed. See [Deleting a namespace](#deleting-a-namespace). |

The infra build doesn't load the class, or its imports such as `cloudflare:workers`. It replaces the class with a function of the same name.

### Hosting

Exactly one of the Workers that bind a namespace exports its class, and that Worker hosts the namespace. Every other Worker that binds the namespace binds it on the hosting Worker, and is uploaded after it. Plan fails when:

- no Worker that binds the namespace exports the class. The error names the Worker's module. A class re-exported with `export * from` is not found, because the bundle doesn't re-export the names of `export *`.
- two Workers that bind the namespace export the class.
- one Worker hosts two namespaces with the same class.

The host is found by the export's name only. A Worker that binds the namespace and exports a different class under the same name, such as another `Counter`, is taken as the host.

### Renaming, moving and deleting

A new namespace uses SQLite storage. Deploy uploads Cloudflare's declarative `exports` map of the hosting Worker, with each namespace that the Worker hosted before. Cloudflare keys a namespace by its Worker and its class name, and deleting a namespace deletes all its objects, which can't be undone. So plan and deploy fail, before deploy changes anything, for a change that would delete a namespace that is protected in state:

- When a namespace's `class` changes and its `id` stays the same, deploy renames the class, and the namespace keeps its objects.
- A namespace's `id` can't change. Plan fails, and says to change the id back. When the `class` changes too, plan can't pair the old and new namespaces, so it fails with the message for a deleted namespace, which also says to change the id back if it changed.
- When the hosting Worker no longer hosts a namespace, plan fails, unless the namespace is unprotected in state. See [Deleting a namespace](#deleting-a-namespace).
- When a namespace's class export moves to another Worker, and the old host still binds the namespace, deploy moves the namespace and its objects to the new host. See [Moving a namespace](#moving-a-namespace). When the old host no longer binds the namespace, plan fails, unless the namespace is unprotected in state.
- When a Worker is removed, as when its `id` changes, deploy deletes all its namespaces. Plan fails unless each of them is unprotected in state.
- Plan fails if a namespace takes a class that another namespace had on the same Worker before, as the new namespace would get the old one's objects. Rename or delete the old namespace in one deploy, and give its class to the new namespace in a later deploy.

`notation destroy` doesn't make these checks. It deletes each Worker with its namespaces.

### Moving a namespace

To move a namespace to another Worker, export its class from the new host's module, and stop exporting it from the old host's module. Keep binding the namespace from the old host in the same deploy:

::code-group

```ts [runtime/web.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { rooms } from "./rooms";
// No longer exports Room.

export const worker = $worker({
  id: "web",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ ROOMS: rooms }),
});

export default {
  async fetch(request, env) {
    return new Response(env.ROOMS.idFromName("lobby").toString());
  },
} satisfies WorkerHandler<typeof worker>;
```

```ts [runtime/api.ts]
import { $worker, type WorkerHandler } from "@notation/cloudflare/workers";
import { rooms } from "./rooms";
export { Room } from "./rooms";

export const worker = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ ROOMS: rooms }),
});

export default {
  async fetch(request, env) {
    return new Response(env.ROOMS.idFromName("lobby").toString());
  },
} satisfies WorkerHandler<typeof worker>;
```

::

The old host now binds the namespace on the new host, so deploy uploads the new host first. That upload moves the namespace in three steps:

1. Deploy uploads the new host with the class expecting the namespace, and without its binding to the namespace.
2. Deploy sets the class as transferred on the old host. Cloudflare moves the namespace, with its objects.
3. Deploy uploads the new host again, with the binding.

Then deploy uploads the old host, with its binding on the new host. A later deploy can remove that binding.

Between steps 1 and 3, the new host's `env` has no binding to the namespace, so a request on the new host that uses it fails. From step 2 until deploy uploads the old host, the old host's deployed version still binds the class as its own, so a request on the old host that uses it fails too. If step 2 fails, the namespace and its objects stay on the old host, and the new host's class waits for them. The next deploy runs the move again.

To find the old host, deploy lists the account's namespaces when a Worker hosts a namespace that is new to it, and another Worker binds that namespace. The new host reads the names of the Workers that bind the namespace from their state records at the start of the deploy, as those Workers depend on it. If one of those Workers hosts a namespace with the same class, deploy moves it. If none does, the namespace is new. A Worker that this deploy creates has no record, and has never hosted the namespace, so it is left out.

When a Worker that binds the namespace has no state record, deploy also checks that no Worker in the account with a name that deploy gives that Worker hosts the class. Such a Worker may be the old host, with its state record lost. Without the check, the new host would start an empty namespace while the old Worker keeps the objects. The names are `<app>--<stage>--<id>-` followed by 8 hex characters, cut as deploy cuts a long name. When such a Worker hosts the class, deploy fails and names it. The check never moves a namespace. It can fail a deploy that is correct: a Worker whose id ends in something that looks like an instance, such as `orders-deadbeef`, has a name that matches `orders`. Two Workers whose long names are cut to the same part match each other. Two Workers whose ids differ only in runs of hyphens, such as `a--b` and `a-b`, also match each other, as deploy puts one hyphen in a generated name for each run.

Plan fails when:

- the namespace's `class` also changes. Move the namespace first, and change the class in a later deploy.
- the namespace that moves has the class of another namespace that the old host had before. The moved namespace would get that namespace's objects.
- the old host no longer binds the namespace, and the namespace is protected in state. Without the binding, deploy doesn't know where the namespace moves to, and the old host's upload would delete it.
- the new host gets a namespace that another Worker binds, and the same deploy renames or deletes another namespace of the new host. The first upload of a move would apply the rename or delete before the move is done. Plan can't tell whether the namespace moves or is new, so it fails in both cases. Make the two changes in separate deploys.

Deploy fails, before it uploads the new host, when this deploy creates the new host, and when the check above finds a Worker with no state record. Plan doesn't catch this, as plan doesn't list the account's namespaces. Deploy the new host without the namespace first. Deploy also fails when the old host hosts a namespace with key-value storage, which Notation doesn't support, or a namespace that Cloudflare's list doesn't show as SQLite.

If a move stops part way through, the next deploy finishes it. The new host's state is updated only after the last upload, so the next deploy runs the move again. It finds the namespace on the old host, or on the new host if Cloudflare already moved it.

### Deleting a namespace

Deleting a namespace takes two deploys. First set `protect: false` on its declaration, and deploy while the Worker still hosts the namespace:

```ts [runtime/rooms.ts]
export const rooms = $durableObject({
  id: "rooms",
  class: Room,
  protect: false,
});
```

This deploy saves the value in the state of the hosting Worker. Plan lists the Worker as an update, and deploy uploads it again, without changing the namespace.

In a later deploy, remove the declaration, its binding and its class. Deploy uploads a `deleted` entry for the namespace's class. The Worker's module must no longer export the class, or Cloudflare rejects the upload. In the same way, a later deploy can remove the hosting Worker, or change its `id`, once all its namespaces are unprotected in state.

Plan reads `protect` from state, not from code. A deploy that sets `protect: false` and also stops hosting the namespace fails at plan.

## Credentials

Deploy reads two environment variables:

- `CLOUDFLARE_API_TOKEN`: an API token with the **Workers Scripts: Edit** permission.
- `CLOUDFLARE_ACCOUNT_ID`: the account to deploy to. It is stored in state, so a later deploy updates or deletes each Worker in the account it was made in.

A Worker can't move to another account. If `CLOUDFLARE_ACCOUNT_ID` changes, plan and deploy fail, because replacing each Worker would delete the objects of the namespaces that it hosts. To deploy to another account, first run `notation destroy` with the old account, or deploy to another stage.

A generated name ends in a random instance, so a Worker that someone else made in the account does not have it. When a create stops before deploy records it, the next deploy finds the Worker under the name in the `creating` record, and takes it over. See [Recoverable creates](../../internals/reconciler.md#recoverable-creates).
