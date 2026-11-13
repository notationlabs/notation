---
"@notation/cloudflare": minor
---

Deploy now generates the name of a Cloudflare Worker, as it does for AWS names (RFC 0018).

- **Breaking:** `$worker` no longer takes a `name` option. Code that passes it no longer type-checks.
- A Worker that deploy creates is named `<app>--<stage>--<id>-<instance>`, with 8 random hex characters as the instance, such as `shop--prod--orders-3f9a1c2e`. Before, it was named `<app>--<stage>--<id>`, or `<app>--<stage>--<name>`. A name that is too long is cut before the instance.
- The longest name is 54 characters, not 63. A Worker's name is the first label of its workers.dev URL, and a preview URL puts an 8 character version prefix and a hyphen in the same label.
- **A Worker in state keeps its name.** An upgrade renames nothing.
- Turning on workers.dev for a Worker with a name longer than 54 characters, which an earlier version could give, now turns off its preview URLs. Cloudflare refuses preview URLs for such a name, and before, turning on workers.dev failed with error 100315.
- Plan shows the name of a Worker that deploy creates as unknown, and so its workers.dev URL, a Durable Object binding to a namespace that it hosts, and a service binding to it.
- `WorkerScript`'s `ScriptName` has a `physicalName` rule, so config can't set it. A Durable Object binding to a namespace on another Worker, and `BoundDurableObjects[].scriptName`, read the host's name through an output ref. A Worker that binds itself as a service refers to its own name, and is created once with the binding. The binding is now a contribution, as for a service binding to another Worker, so it comes after the bindings in config. A Worker that binds itself is updated once on the next deploy when this changes the order of its bindings.
- `DurableObjectTransferSources` now holds one entry for each hosted namespace and each other Worker that binds it: the namespace id, the Worker's `$worker` id, its name from its state record, and the names that deploy gives it. The host reads the names of those Workers from state, with no dependency on them. The param is hidden and not compared, so the change of shape does not update a Worker.
- When a namespace is new to a Worker, and a Worker that binds it has no state record, deploy fails if a Worker in the account with a name that deploy gives that Worker hosts the namespace's class. Such a Worker may be the old host, with its record lost. Without the check, the new host would start an empty namespace while the old Worker keeps the objects. The check matches a generated name, cut as deploy cuts it, and the name `<app>--<stage>--<id>` that an earlier version gave the Worker. It does not match a name that an earlier version made from the `name` option. It can fail a deploy that is correct, for a Worker whose id ends in something that looks like an instance.
- `$worker` no longer checks that no two Workers get the same name.
- **Breaking:** `WorkerGroupConfig` in `@notation/cloudflare/workers` no longer has `scriptName` or `transferSources`.
- Finish or cancel a deploy that is in progress before you upgrade. A deploy that was started on an earlier version and is resumed after the upgrade replays the params that it recorded for each Worker it had reached. Those params hold `ScriptName`, which config can no longer supply, so the deploy fails at that Worker.
