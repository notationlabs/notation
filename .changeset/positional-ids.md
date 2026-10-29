---
"@notation/aws": minor
"@notation/aws.iac": minor
"@notation/core": minor
"@notation/resource": minor
---

Resources and resource groups take their ID as their first argument, ahead of their options:

```ts
// before
new LambdaIamRole({ id: "todos-role", config: { RoleName: "todos-role" } });
super("Lambda", { id: config.id, config });

// after
new LambdaIamRole("todos-role", { config: { RoleName: "todos-role" } });
super("Lambda", config.id, config);
```

- A resource's options can be left out when neither `config` nor `dependencies` has a required property: `new TestResource("a")`.
- `ResourceGroup.addOnce` takes the ID separately: `group.addOnce(LambdaIntegration, id, { dependencies })`.
- `ResourceOpts` no longer includes `id`.
- `ResourceGroupOptions` is removed.

The `@notation/aws` functions, such as `lambda({ id, ... })`, still take an object.
