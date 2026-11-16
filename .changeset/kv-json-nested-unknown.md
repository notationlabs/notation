---
"@notation/cloudflare": patch
---

`kvJson()` accepts a schema whose input has `unknown` or `any` at any depth, such as `v.looseObject()` or `v.objectWithRest(..., v.unknown())`, and a recursive JSON schema built with `v.lazy()`, which failed with "Type instantiation is excessively deep". A schema whose input isn't JSON is now a type error that names the key, such as `kvJson(): the input type of the schema must be JSON, but the key meta.at isn't`. `json()` bindings keep their check, which refuses `unknown`.
