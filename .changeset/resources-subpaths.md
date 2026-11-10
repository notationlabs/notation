---
"@notation/aws": minor
"@notation/std": minor
"@notation/core": minor
"@notation/resource": minor
---

The AWS resource classes move from `@notation/aws.iac` to `@notation/aws/resources`. The standard resource classes move from `@notation/std.iac` to `@notation/std/resources`. `@notation/aws.iac` and `@notation/std.iac` are no longer published.

```ts
import { lambda, sqs } from "@notation/aws/resources";
import { fs } from "@notation/std/resources";
```

- A provider is a package or a package subpath, such as `@notation/aws/resources`. Its entry must export only resource classes, or namespaces whose values are all resource classes. Plan, deploy and destroy skip a provider that exports any other value, with a `reconciler.provider.load-failed` warning that names the value.
- A provider name can't contain `\` or `%`, as in Node's package names.
- `resourceClasses` is removed from both packages, and `resourceClassesIn` is removed from `@notation/resource`.
- `AwsResourceGroup` is exported from `@notation/aws/shared`.
- `apiGateway.routeSchema`, `lambda.LAMBDA_ENVIRONMENT_MAX_BYTES`, `fs.fileSchema` and `fs.zipSchema` are no longer exported, because a provider entry can export only resource classes.
