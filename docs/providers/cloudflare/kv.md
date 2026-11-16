# KV

`@notation/cloudflare` declares [Workers KV](https://developers.cloudflare.com/kv/) namespaces and the keys in them. A Worker binds a namespace and reads its keys at runtime.

| Declaration      | Package entry                    | What it stores in a key          |
| ---------------- | -------------------------------- | -------------------------------- |
| `kv.KVNamespace` | `@notation/cloudflare/resources` | Nothing. It holds the keys       |
| `kv.KVValue`     | `@notation/cloudflare/resources` | One string, as it is             |
| `kvJson()`       | `@notation/cloudflare/kv`        | One JSON document, with a schema |

## `kv.KVNamespace`

A namespace has a title, which is unique in the account:

```ts [infra/config.ts]
import { kv } from "@notation/cloudflare/resources";

export const config = new kv.KVNamespace("config", {
  config: { Title: "shop-config" },
});
```

- `AccountId` is `CLOUDFLARE_ACCOUNT_ID`.
- `Jurisdiction`, `"eu"`, `"fedramp"` or `"us"`, is set only when the namespace is created.
- Deploy refuses a change that would replace the namespace, because a replace deletes its keys.

A Worker binds the namespace as a `KVNamespace`. See [Bindings](workers.md#bindings).

## `kv.KVValue`

A `KVValue` writes one string to one key:

```ts [infra/config.ts]
export const banner = new kv.KVValue("banner", {
  config: { Key: "banner", Value: "Free delivery this week" },
  dependencies: { namespace: config },
});
```

- Create fails when the key already exists, so deploy never overwrites a key that it did not write.
- A change to `Key` writes the new key first, and deletes the old key at the end of the deploy.
- KV is eventually consistent. After a write, deploy reads the key until it returns the written value, for up to about 60 seconds.
- Plan reads the key, and plans an update when the stored value differs from `Value`.

## `kvJson()`

`kvJson()` declares a JSON document in a key. The document is built from parts that different infra modules contribute, and a schema checks the merged document at plan and deploy.

The example below is a set of feature flags. The billing and uploads modules each own some of the flags.

### The schema

The schema goes in a shared module, so that the infra and the Worker import the same schema:

```ts [shared/flags.ts]
import * as v from "valibot";

export const FLAGS_KEY = "flags";

export const Flags = v.object({
  features: v.record(v.string(), v.boolean()),
  limits: v.optional(v.record(v.string(), v.number())),
});
```

Any [Standard Schema](https://standardschema.dev) works, such as a valibot or Zod schema. Its input type must be JSON. Its output type can be any type: a schema can turn a string into a `Date`, as described in [Reading the document in a Worker](#reading-the-document-in-a-worker).

### Declaring the document

```ts [infra/config.ts]
import { kvJson } from "@notation/cloudflare/kv";
import { kv } from "@notation/cloudflare/resources";
import { Flags, FLAGS_KEY } from "../shared/flags";

export const config = new kv.KVNamespace("config", {
  config: { Title: "shop-config" },
});

export const flags = kvJson({
  id: "flags",
  namespace: config,
  key: FLAGS_KEY,
  schema: Flags,
  value: { features: {} },
});
```

| Option      | Notes                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Keys the document in state. The resource ID is `kv-json:<id>`. Use 1 to 64 letters, digits, hyphens or underscores. An ID such as `${id}-config` is checked when infra runs |
| `namespace` | The `KVNamespace` that holds the key                                                                                                                                        |
| `key`       | The KV key                                                                                                                                                                  |
| `schema`    | Checks the merged document at plan and deploy                                                                                                                               |
| `value`     | Optional. The first part of the document, before the contributions                                                                                                          |

`kvJson()` returns a `KVJsonGroup`. `flags.schema` is the schema, and `flags.value` is the `kv.KVJsonValue` resource that writes the key.

### Contributing to the document

Each module adds its own keys with `flags.contribute`:

::code-group

```ts [infra/billing.ts]
import { flags } from "./config";

flags.contribute({ features: { invoices: true } });
```

```ts [infra/uploads.ts]
import { flags } from "./config";

flags.contribute({ features: { uploads: true }, limits: { uploadMb: 50 } });
```

::

Deploy merges `value` and both contributions, and writes this text to the key `flags`:

```text
{"features":{"invoices":true,"uploads":true},"limits":{"uploadMb":50}}
```

Deploy sorts the object keys, so the same document always gives the same text. The merge follows these rules:

- **Object keys merge at every depth.** The billing module sets `features.invoices` and the uploads module sets `features.uploads`, so both apply.
- **Two parts that set one key to different values conflict.** Plan fails and names the line of each `contribute` call. When `value` is one side, the error names it as `the config of kv-json:flags`.
- **An array or a scalar is set whole.** Two contributions that set the same array to different arrays conflict. For a list that several modules add to, use an object keyed by a name that each module chooses.
- **Removing a contribution removes its keys.** The next deploy writes the document without them.

The type of each contribution is a `JsonPartial` of the schema's input: every object key is optional, at every depth. So `flags.contribute({ features: { invoices: "yes" } })` is a type error.

A contribution can also hold an output ref, or be a function of the outputs of its deps, as `Resource.contribute` takes. See [Function contributions](../../reference/resource.md#function-contributions). When the function reads an output that does not exist yet, such as on the first deploy of a dep, plan can't tell which keys it sets, and checks the document only at deploy.

### The schema check

Plan checks the merged document against the schema before deploy writes anything. A contribution of `{ features: { invoices: "yes" } }` fails at plan:

```text
✗ Invalid Value for kv-json:flags (cloudflare/kv/KVJsonValue) at plan, declared at infra/config.ts:9: features.invoices: Invalid type: Expected boolean but received "yes"
```

The error names the `kvJson()` call, not the contribution. The path, `features.invoices`, tells you which contribution set the field.

Notation checks the document at three points:

| Point       | What is checked                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Declaration | Nothing. A later contribution can still supply a field that the schema requires                                                        |
| Plan        | The merged document. Fields that hold an output ref that is not known yet are left out                                                 |
| Deploy      | The known fields before deploy changes anything, and the whole document, with every output ref filled in, before deploy writes the key |

**The schema only checks the document.** Deploy writes the merged document as it is, not the schema's output. A default in the schema applies in the Worker, but deploy does not write it.

Deploy also refuses a value that `JSON.stringify` would change, such as `NaN`, a `Date`, a sparse array, a key set to `undefined`, or a key named `__proto__`. The stored text is at most 25 MiB.

### Drift

Plan reads the key and compares the parsed document with the merged document. When the key holds text that is not JSON, or JSON that deploy would refuse, such as `[1e999]`, plan reads it as a JSON string. Text too long to hold as a JSON string within 25 MiB reads as a short string that gives its length. That string differs from the document, so plan shows an update and deploy writes the key again.

## Reading the document in a Worker

A Worker binds the namespace, and reads the key with `readKVJson(namespace, key, schema)` from `@notation/cloudflare/workers`:

```ts [runtime/api.ts]
import {
  $worker,
  readKVJson,
  type WorkerHandler,
} from "@notation/cloudflare/workers";
import { Flags, FLAGS_KEY } from "../shared/flags";
import { config } from "../infra/config";

export const worker = $worker({
  id: "api",
  compatibilityDate: "2026-10-12",
  bindings: () => ({ CONFIG: config }),
});

export default {
  async fetch(request, env) {
    const flags = await readKVJson(env.CONFIG, FLAGS_KEY, Flags);
    if (!flags?.features.uploads)
      return new Response("Not found", { status: 404 });
    // ...
  },
} satisfies WorkerHandler<typeof worker>;
```

`readKVJson()` does three things:

1. It reads the key as text. For a missing key it returns `undefined`.
2. It parses the text. Text that is not JSON throws a `KVJsonError` with the key.
3. It validates the value with the schema, and returns the schema's output. A value that fails throws a `KVJsonError` with the key and the schema's issues in `issues`.

A fourth argument passes options to `get`, such as `{ cacheTtl: 300 }`.

**The Worker must handle `undefined`.** The Worker binds the namespace, not the document, so deploy can put the Worker live before it writes the key. After a write, other locations can also return no key for about 60 seconds.

The Worker imports the schema and the key from `shared/flags.ts`, not from `flags`. The runtime build keeps only the keys of a Worker's bindings, so the handler can't read values from `infra/config.ts`. Nothing checks that the Worker passes the same schema as the document.

## Changing a schema

The Worker and the document go live at different times. For about a minute, the new Worker can read the old document, and the old Worker can read the new one. A new schema must therefore accept the document that the previous schema accepted:

| Change                | Safe way to make it                                                              |
| --------------------- | -------------------------------------------------------------------------------- |
| Add a field           | Make it optional, or give it a default                                           |
| Remove a field        | Remove every contribution that sets it, deploy, then remove it from the schema   |
| Change a field's type | Add a field with the new type, move the contributions, then remove the old field |

A change to the schema changes no param, so it plans no update by itself. The next plan checks the current document against the new schema.

## Limits

- **Moving a key from `KVValue` to `kvJson()` fails.** Deploy creates the document before it deletes the `KVValue`, and create refuses a key that exists. Remove the `KVValue` in one deploy and declare the document in the next, or give the document another key.
- **A change to `id` with the same `key` fails** for the same reason: a new `id` is a new resource. Change the `key` with the `id`, or remove the document in one deploy and declare it again in the next.
- **State holds the document twice**, in the params and in the outputs. Keep large documents in R2.
- **A check of an unknown field waits for deploy.** A field that holds a ref to an output that the same deploy creates is checked only before deploy writes the key. When a function contribution reads such an output, the whole document is checked then. Deploy can then fail after it has changed other resources.
