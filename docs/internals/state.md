# State

Notation tracks deployed resources in a state backend. State is the bridge between what is defined and what actually exists in the cloud.

Source: `@notation/state`

## State file

Default location: `.notation/state.json`. Override with the `NOTATION_STATE_PATH` environment variable.

Each resource entry records everything needed to diff, update, or delete the resource:

```json
{
  "my-api-lambda-getTodos": {
    "id": "my-api-lambda-getTodos",
    "type": "aws/lambda/LambdaFunction",
    "config": {
      "service": "aws/lambda",
      "timeout": 5,
      "memory": 64
    },
    "params": {
      "FunctionName": "my-api-getTodos",
      "Runtime": "nodejs18.x",
      "Handler": "index.getTodos",
      "MemorySize": 64,
      "Timeout": 5
    },
    "output": {
      "FunctionArn": "arn:aws:lambda:us-east-1:123456789:function:my-api-getTodos",
      "FunctionUrl": "https://xyz.lambda-url.us-east-1.on.aws/"
    },
    "lastOperation": "create",
    "lastOperationAt": "2027-01-15T10:30:00.000Z"
  }
}
```

Key fields:

- **`id`** – unique identifier derived from the resource's position in the graph
- **`type`** – the resource type string (e.g., `aws/lambda/LambdaFunction`)
- **`config`** – user-facing configuration values
- **`params`** – the full set of parameters sent to the cloud provider
- **`output`** – computed values returned by the provider after creation
- **`lastOperation`** – what the reconciler last did (`create`, `update`, `delete`)
- **`lastOperationAt`** – ISO timestamp of the last operation

## Backends

Two built-in backends:

### `FileStateBackend` (default)

Reads and writes JSON to disk. Uses atomic writes – writes to a temporary file first, then renames – to prevent corruption if the process is interrupted mid-write.

```ts [packages/state/src/file.ts]
const state = new FileStateBackend(".notation/state.json");
```

### `MemoryStateBackend`

In-memory backend used for testing. Deep-clones on read and write to simulate persistence semantics (mutations to returned objects don't affect stored data).

```ts [packages/state/src/memory.ts]
const state = new MemoryStateBackend();
```

### `StateBackend` interface

Both backends implement the same interface:

```ts [@notation/state/src/backend.ts]
interface StateBackend {
  get(id: string): Promise<StateNode | undefined>;
  has(id: string): Promise<boolean>;
  update(id: string, patch: Partial<StateNode>): Promise<void>;
  delete(id: string): Promise<void>;
  values(): Promise<StateNode[]>;
}
```

The interface is deliberately minimal. There are no queries, transactions, or locking. Each operation targets a single resource by ID, which will make it straightforward to add new backends (e.g., Sqlite, S3).

## How state is used

### Deploy

The reconciler reads state to diff against the desired resource graph:

1. For each resource in the graph, check if it exists in state
2. If it exists, compare `params` to detect changes
3. Execute the appropriate operation (create, update, noop)
4. After each operation, update the state entry with new params and output

### Destroy

The reconciler reads state to find resources to delete:

1. Load all state entries
2. Delete resources in reverse dependency order
3. Remove each entry from state after successful deletion

### Orphan detection

The reconciler checks for orphaned resources – resources that exist in state but are no longer present in the resource graph. This happens when you remove a function export or delete a `.fn.ts` file.

Orphaned resources are deleted from AWS and removed from state.
