---
"@notation/resource": minor
"@notation/reconciler": minor
---

A resource class can set `replaceCreatesFirst` in its meta, in `@notation/resource`. The reconciler then replaces a resource of that class create-first, as it does a class with a `physicalName` param: deploy creates the replacement, and deletes the old resource at the end of the deploy. If the create fails, the old resource stays as it was. Set it when every replace changes the resource's key, so that the replacement can exist beside the old resource.
