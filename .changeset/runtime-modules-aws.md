---
"@notation/aws": minor
"@notation/aws.iac": minor
---

A runtime module deploys as one Lambda function, which dispatches each event to an export of the module.

- `LambdaResource` in `@notation/aws/lambda.fn` types a runtime module's `resource` export. It replaces `LambdaConfig` in `@notation/aws/lambda.fn`.
- Lambda IDs are per module, not per export. With `id: "todos"`, the function is `todos`, not `todos-getTodos`. The next deploy of an existing stack replaces its Lambda functions.
- `timeout` and `memory` now apply to the function. `lambda()` takes both.
- `handler` in `lambda()` is optional, and defaults to `"handler"`. Lambda calls `<file name>.<handler>`.
- `route()`, the router methods, `queue.consume()` and `schedule()` take a `RuntimeRef` or a Lambda group from `lambda()`. A `RuntimeRef` is `{ resource, export }`, where `resource` is a Lambda group. An import of a runtime module's export is a `RuntimeRef` in infra code, typed as its handler. Each API checks the handler type: the router methods take API request handlers, the methods of a router with a JWT authorizer take handlers for its claims type, `queue.consume()` takes SQS handlers, and `schedule()` takes EventBridge schedule handlers.
- A Lambda group from `lambda()` runs external code, so it adds no dispatch entry, and a schedule sends it the EventBridge event as it is.
- `createDispatcher(mod)` in `@notation/aws/lambda.fn` makes a module's single entry point. It sends a scheduled invocation to the export that the event names, and an HTTP API request or SQS message to the export that the function's dispatch map gives. An event with no entry goes to the module's only handler for that kind of event (API, SQS, DynamoDB or schedule), told apart by the event's shape. Only exports made with `handle.*` count as handlers.
- For a runtime module's export, a schedule's rule sends `{ "export": "<name>", "event": <EventBridge event> }` to the function, in place of the EventBridge event alone.
- Each route and queue subscription adds an entry to the function's dispatch map. `LambdaFunction` in `@notation/aws.iac` holds the map at `Environment.Runtime`, and stores it in a compact form in the `NOTATION_RUNTIME` variable. A variable with that name in `Environment.Variables` fails the deploy. So does an environment over Lambda's 4 KB limit, which plan also reports.
- `@notation/aws.iac/shared` exports `runtimeVariable`, `encodeRuntime`, `decodeRuntime` and the dispatch types. It doesn't import the AWS SDK.
- `@notation/aws.iac` now has an `exports` map with two entry points, `@notation/aws.iac` and `@notation/aws.iac/shared`. Imports of other paths in the package, such as `@notation/aws.iac/dist/...`, no longer resolve.
- The `@notation/aws` entry points recognise a Lambda group by a mark, not by its class, so a group from one entry point, or from another installed copy of the package, passes the checks in the others.
