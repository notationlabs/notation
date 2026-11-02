---
"@notation/aws": minor
"@notation/aws.iac": minor
---

A runtime module deploys as one Lambda function, which dispatches each event to an export of the module.

- `LambdaResource` in `@notation/aws/lambda.fn` types a runtime module's `resource` export. It replaces `LambdaConfig` in `@notation/aws/lambda.fn`.
- Lambda IDs are per module, not per export. With `id: "todos"`, the function is `todos`, not `todos-getTodos`. The next deploy of an existing stack replaces its Lambda functions.
- `timeout` and `memory` now apply to the function. `lambda()` takes both.
- `lambda()` no longer takes `handler`. The code must export `handler`, and Lambda calls `<file name>.handler`.
- `route()`, the router methods, `queue.consume()` and `schedule()` take a `RuntimeRef`: `{ resource, export }`, where `resource` is a Lambda group from `lambda()`. An import of a runtime module's export is a `RuntimeRef` in infra code. To pass a group from `lambda()`, write `{ resource: fn, export: "handler" }`.
- `createDispatcher(mod)` in `@notation/aws/lambda.fn` makes a module's single entry point. It sends a scheduled invocation to the export that the event names, and an HTTP API request or SQS message to the export that the function's dispatch map gives. A module with one handler gets every other event.
- A schedule's rule sends `{ "export": "<name>", "event": <EventBridge event> }` to the function, in place of the EventBridge event alone. Code from `lambda()` that handles a schedule reads the event from `event.event`.
- Each route and queue subscription adds an entry to the function's dispatch map. `LambdaFunction` in `@notation/aws.iac` holds the map at `Environment.Runtime`, and stores it in the `NOTATION_RUNTIME` variable. A variable with that name in `Environment.Variables` fails the deploy.
- `@notation/aws.iac/shared` exports `runtimeVariable`, `encodeRuntime`, `decodeRuntime` and the dispatch types. It doesn't import the AWS SDK.
- The `@notation/aws` entry points share one copy of `LambdaGroup`, so a group from `@notation/aws/lambda` passes the checks in `@notation/aws/api-gateway`, `@notation/aws/sqs` and `@notation/aws/event-bridge`.
