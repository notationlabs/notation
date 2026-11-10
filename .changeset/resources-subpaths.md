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

- A provider is a package or a package subpath, such as `@notation/aws/resources`. Deploy and destroy register each resource class among the entry's exports and among the values of each exported namespace, if the class declares that provider. Other exports are ignored.
- A provider name can contain only letters, digits, `_`, `.`, `~` and `-`, with `@` before a scope and `/` between segments. A segment can't start with a dot.
- `resourceClasses` is removed from both packages, and `resourceClassesIn` is removed from `@notation/resource`.
- `AwsResourceGroup` is exported from `@notation/aws/shared`.
