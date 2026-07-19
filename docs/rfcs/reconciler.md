# RFC: Reconciler

**Status:** implemented
**Scope:** `@notation/state`, `@notation/reconciler`

Notation evaluates an infrastructure program into resources, then reconciles those
resources against recorded state. The same engine now runs behind the CLI, the dashboard,
and direct library integrations.

```ts
import { Reconciler } from "@notation/reconciler";
import { SqliteStateBackend } from "@notation/state-sqlite";

const state = new SqliteStateBackend(".notation/state.db");
const reconciler = new Reconciler({ state });

await reconciler.deploy(resources);
state.close();
```

The reconciler boundary consists of live resource objects, a state backend, and an event
subscriber. Resource operations run in the host process.

## State

Each state record carries a revision. Updates and deletes can require the revision which
the caller previously read:

```ts
await state.update(resource.id, patch, resource.rev);
```

A stale writer receives `RevConflict`. A missing record has revision zero, so
`expectedRev: 0` means that the record must not exist.

The reconciler also takes a renewable per-resource lease before it reads a resource for
mutation. The lease remains held across the provider operation and state write. Two
hosts therefore cannot create or update the same resource concurrently through the same
backend.

Orphan deletion takes an additional snapshot lease. The snapshot remains stable while
the reconciler decides which state records no longer appear in the desired graph.

## Backends

`@notation/state` provides file and memory backends. `@notation/state-sqlite` provides
the reference database backend.

Every backend implements the same contract:

```ts
interface StateBackend {
  get(id: string): Promise<StateNode | undefined>;
  has(id: string): Promise<boolean>;
  update(
    id: string,
    patch: Partial<StateNode>,
    expectedRev?: number,
  ): Promise<{ rev: number }>;
  delete(id: string, expectedRev?: number): Promise<void>;
  values(): Promise<StateNode[]>;
  lease(scope: string, ttl: number): Promise<Lease>;
}
```

The dashboard reads this interface. It does not inspect a state file directly.

## Events

The reconciler accepts one subscriber:

```ts
const reconciler = new Reconciler({
  state,
  emit: async (event) => auditLog.write(event),
});
```

`createNdjsonEventEmitter` adapts the subscriber to a versioned newline-delimited JSON
stream. The CLI uses the same adapter for `deploy --json` and `destroy --json`.

## Package boundary

The CLI creates resources from compiled Notation programs, then hands those live objects
to `Reconciler`. An application can construct the same resource classes directly.

The reconciler does not serialise resource classes or execute operations in another
process. Detached execution needs manifests, resource-reference encoding, actuator
binding, and a runtime consumer. That work has its own RFC and release.

## Acceptance

The reconciler example is the compatibility test for this boundary. It must:

1. Construct a resource without the CLI.
2. Plan and deploy it through `Reconciler`.
3. Close and reopen SQLite state.
4. Plan and apply an update.
5. Receive versioned events.
6. Destroy the resource and remove its state.

The example lives in `examples/reconciler` and runs without cloud credentials.
