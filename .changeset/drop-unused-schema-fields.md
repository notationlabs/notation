---
"@notation/resource": minor
"@notation/aws.iac": patch
---

Schema items no longer accept `defaultValue` or `propertyType: "derived"`. Nothing read either at runtime, so a `defaultValue` never filled in a missing param. Set the value in params, or compute it with `deriveParams`.
