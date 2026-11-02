---
"@notation/resource": minor
"@notation/reconciler": minor
"@notation/core": minor
"@notation/std.iac": minor
"@notation/aws.iac": minor
---

Every schema item has a required `value` validator (RFC 0006). It can be any Standard Schema, such as a valibot, Zod, ArkType or Effect schema. The engine calls only `~standard.validate`.

```ts
MaxSessionDuration: {
  propertyType: "param",
  presence: "optional",
  value: v.number(),
},
```

The validator's output type is the field's type, and TypeScript checks it against the API schema's type for the field. `value` replaces `valueType`, and `typed` is removed.

The engine validates config when a resource is declared, known params at plan, known params before deploy changes anything, each resource's full params just before its operation, and every `create` and `read` result. An invalid value raises `ValueValidationError`, which names the resource, the field and the call site that declared the resource. A malformed read fails the plan or deploy.

The engine also raises `SchemaStructureError` when params hold a field that is not a param, when `create` returns a field that is not computed, or when a required computed field is missing after create or update.

The aws.iac resources now reject values that AWS would reject: a value not in the SDK's list for an enum field, an SQS queue attribute outside its range, a `TimeoutInMillis` that is not an integer, and a role policy document that does not follow the IAM policy grammar. `InvocationType` is removed from `LambdaApiPermission` and `LambdaEventBridgeRulePermission`, because `AddPermission` does not accept it and the SDK dropped it.

Known limit: string-union fields are checked against the SDK's list of values. A value that AWS adds after the pinned SDK version, such as a new Lambda runtime, fails validation. A read that returns such a value fails the plan until RFC 0009 makes malformed reads recoverable.
