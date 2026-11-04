---
"@notation/aws": minor
"@notation/aws.iac": minor
---

A runtime module deploys as one Lambda function. The function dispatches each event to an export of the module.

- `LambdaResource` replaces `LambdaConfig` in `@notation/aws/lambda.fn`. It types a runtime module's `resource` export.
- Lambda IDs are per module, not per export. With `id: "todos"`, the function is `todos`, not `todos-getTodos`. The next deploy of an existing stack replaces its Lambda functions.
- `lambda()` takes `timeout` and `memory`, and both now apply to the function.
- `handler` in `lambda()` is optional. It defaults to `"handler"`, so Lambda calls `<file name>.handler`.
- `route()`, the router methods, `queue.consume()` and `schedule()` take a `RuntimeRef` or a Lambda group from `lambda()`. A `RuntimeRef` is `{ resource, export }`, where `resource` is a Lambda group. In infra code, an import of a runtime module's export is a `RuntimeRef`, typed as its handler.
- Each of these APIs checks the handler type. Routes take API request handlers, and a router with a JWT authorizer takes only handlers for its claims type. `queue.consume()` takes SQS handlers, and `schedule()` takes EventBridge schedule handlers.
- A Lambda group from `lambda()` runs external code. It gets no dispatch entries, and a schedule sends it the EventBridge event unchanged.
- `createDispatcher(mod)` in `@notation/aws/lambda.fn` makes a module's single entry point. A scheduled invocation goes to the export it names, which must be a schedule handler. An HTTP API request or SQS message goes to the export that the dispatch map gives. An event with no dispatch entry throws.
- For a runtime module's export, a schedule's rule sends `{ "export": "<name>", "event": <EventBridge event> }` in place of the EventBridge event.
- Each route and queue subscription adds an entry to the function's dispatch map. `LambdaFunction` in `@notation/aws.iac` holds the map at `Environment.Runtime`, and stores it in compact form in the `NOTATION_RUNTIME` variable. The deploy fails if `Environment.Variables` sets `NOTATION_RUNTIME`, or if the environment is over Lambda's 4 KB limit. The error names the function.
- `@notation/aws.iac/shared` exports `runtimeVariable`, `encodeRuntime`, `decodeRuntime` and the dispatch types. It doesn't import the AWS SDK.
- `@notation/aws.iac` has an `exports` map with two entry points: `@notation/aws.iac` and `@notation/aws.iac/shared`. Other paths, such as `@notation/aws.iac/dist/...`, no longer resolve.
- `@notation/aws` recognises a Lambda group by a symbol, not by `instanceof`. A group made by another entry point, or by another installed copy of the package, passes its checks.
