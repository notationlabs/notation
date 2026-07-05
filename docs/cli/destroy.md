# notation destroy

```sh
notation destroy <entryPoint>
```

Removes all resources in the stack. Tears down runs in reverse dependency order, so routes are removed before APIs and Lambdas before IAM roles etc.

```sh
notation destroy infra/api.ts
```
