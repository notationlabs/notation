---
"@notation/cloudflare": minor
---

`@notation/cloudflare/resources` exports the resource `cloudflare/r2/R2Bucket`, which creates an R2 bucket. A Worker can't bind a bucket yet.

- Its key is the account, `BucketName` and `Jurisdiction`. Every request sends the `cf-r2-jurisdiction` header. Plan fails when the account, the name or the jurisdiction changes, because a replace would delete the old bucket first.
- `StorageClass` is required, and a change to it is applied in place. `LocationHint` is only used when the bucket is created.
- Create fails when a bucket with the name already exists. Delete fails with a clear message when the bucket still has objects.
- The API token also needs the Workers R2 Storage: Edit permission.
