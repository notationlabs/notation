# Event Protocol

Notation separates structured reconciler output from terminal logging across CLI commands, child watch deploys, Mermaid graph exports, and the local state dashboard.

## Reconciler Events

The reconciler emits a discriminated union `ReconcilerEvent` (`packages/reconciler/src/events.ts`) tagged by `event`:

| Event | Description |
| :--- | :--- |
| `reconciler.operation.lifecycle` | Tracks `create`, `read`, `update`, `delete`, `rotate`, and `load` outcomes |
| `reconciler.deploy.decision` | Reports planned resource actions and replacement or placeholder details |
| `reconciler.drift.detected` | Emits the computed `diff` record when remote state diverges |
| `reconciler.hold.waiting` | Warns when an execution blocks behind `holderExecutionId` on `deploymentId` |
| `reconciler.orphan-deletion.skipped` | Warns when an unregistered orphan and its `keptDependencies` are skipped |
| `reconciler.provider.load-failed` | Warns when dynamic import of a persisted `provider` fails during orphan cleanup |
| `reconciler.source.warning` | Forwards `warn` diagnostics raised by a credential source `read` |

`reconciler.operation.lifecycle` transitions through `"start" | "success" | "error" | "skip" | "dry-run"` and carries optional `reason`, `replacedDependency`, `credential`, `errorName`, and `errorMessage` fields. `reconciler.deploy.decision` reports `"create" | "update" | "replace" | "drift-update" | "drift-replace" | "drift-recreate" | "noop"` with optional `replaceFields`, `replaceOrder` (`"create-first" | "delete-first"`), and `placeholder: true` for cycle placeholders. `reconciler.orphan-deletion.skipped` sets `reason: "resource-type-not-registered"` during `deploy` or `destroy`.

In durable workflows, `durableEmitter` (`packages/reconciler/src/durable/step.ts`) checkpoints each emission via `step.run(emitKey(event), () => emit(event))` (`emit:<event>:<operation>:<status>` for lifecycle events; `emit:<event>` otherwise). Emitters must still tolerate rare duplicates if a crash occurs after delivery and before the step writes its receipt.

## NDJSON Wire Envelope

`packages/reconciler/src/protocol.ts` wraps each `ReconcilerEvent` in a versioned NDJSON envelope (`EVENT_STREAM_VERSION = 1`):

```ts [packages/reconciler/src/protocol.ts]
export const EVENT_STREAM_VERSION = 1 as const;

export type WireReconcilerEvent = ReconcilerEvent & {
  version: typeof EVENT_STREAM_VERSION;
};

export function encodeReconcilerEvent(event: ReconcilerEvent): string {
  return `${JSON.stringify({ version: EVENT_STREAM_VERSION, ...event })}\n`;
}
```

`createNdjsonEventEmitter(write)` wraps `encodeReconcilerEvent` into a `ReconcilerEventEmitter` consumed by `--json` mode and [`notation watch`](./watch-runner.md) child processes.

## Output Mode Selection

`resolveOutputMode` (`packages/cli/src/output.ts`) selects `"pretty"` or `"json"` from CLI flags, TTY detection, and `process.env.CI`:

```ts [packages/cli/src/output.ts]
export function resolveOutputMode(
  flags: { json?: boolean; pretty?: boolean },
  stdout: { isTTY?: boolean } = process.stdout,
  env: { CI?: string } = process.env,
): OutputMode {
  if (flags.json) return "json";
  if (flags.pretty) return "pretty";
  const ci = Boolean(env.CI) && env.CI !== "false" && env.CI !== "0";
  return stdout.isTTY || ci ? "pretty" : "json";
}
```

Commander configures `--pretty` with `.conflicts("json")`. When neither flag is given and `resolveOutputMode` falls back to `"json"` (non-TTY outside CI), the CLI writes a notice to `process.stderr` explaining automatic JSON selection.

## Stream Redirection

When `createEventRenderer("json", logger)` runs, it calls `redirectStdoutToStderr()` (`packages/cli/src/stdio.ts`) before creating the NDJSON emitter:

```ts [packages/cli/src/stdio.ts]
export function redirectStdoutToStderr() {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const write = (line: string): void => {
    originalWrite(line);
  };
  process.stdout.write = ((chunk: any, ...args: any[]) =>
    (process.stderr.write as any)(
      chunk,
      ...args,
    )) as typeof process.stdout.write;
  return {
    write,
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}
```

Saving the bound `originalWrite` for `encodeReconcilerEvent` while routing `process.stdout.write` to `process.stderr.write` prevents `console.log` calls or status banners from corrupting the NDJSON stream on `stdout`.

In `"pretty"` mode, `createPrettyRenderer` wraps `createLoggerReconcilerSubscriber` (`packages/reconciler/src/logger-subscriber.ts`). It styles output with `node:util` `styleText`, writing `"info"` events to `process.stdout` and `"warn"` / `"error"` events to `process.stderr`; `formatPrettyEvent` suppresses `decision: "noop"` events (`undefined`).

## Mermaid Visualization

`createMermaidFlowChart` (`packages/core/src/visualiser/chart.ts`) emits a `flowchart TD` graph for `notation viz`. Because resource and group IDs may contain spaces, braces (such as `/todos/{id}`), or markup characters, nodes and subgraphs use positional IDs (`r0`, `r1`, ... and `g0`, `g1`, ...) with display strings moved into quoted labels.

The generator walks top-level `ResourceGroup` entries (`group.parent === null`) recursively to emit nested `subgraph` blocks, draws ungrouped resources, and appends `source --> target` edges. `label(text)` escapes `#` first (`#35;`) so entity prefixes are not double-escaped, followed by `"` (`#quot;`), `` ` `` (`#96;`), `<` (`#lt;`), and `>` (`#gt;`).

`createMermaidLiveUrl(mermaidCode)` encodes `{ code, mermaid, autoSync: true, updateDiagram: true }` as UTF-8 bytes and compresses them with `pako.deflate(data, { level: 9 })`. It formats the result as URL-safe base64 via `fromUint8Array(compressed, true)` and returns `https://mermaid.live/view#pako:<encoded>`.

## Dashboard SSE Server

`createDashboardServer` (`packages/dashboard/server/server.ts`) serves the built dashboard frontend via `@fastify/static` on `/` (default port `6682`) and streams live state on `GET /state`.

For each SSE client, the route calls `reply.hijack()` and writes `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and `Connection: keep-alive` on `reply.raw`. On initial connection and every `pollInterval` milliseconds (`500` ms default, with `timer.unref()`), `sendState` runs four steps:

1. Guards against overlapping reads (`if (reading || closed) return`).
2. Reads `await state.values()` via `readStateSnapshot(state)` and builds an object keyed by `node.id`.
3. Serializes the snapshot with `JSON.stringify` and compares it against `lastSnapshot`.
4. Writes `data: ${snapshot}\n\n` only when the serialized JSON string changed.

The server clears the interval timer when `request.raw` emits `"close"`. In the browser, `useRemoteState` (`packages/dashboard/src/hooks/remote-state.ts`) consumes `/state` via `new EventSource("/state")`.
