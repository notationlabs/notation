---
"@notation/aws": minor
---

The AWS provider deploys to the region in `AWS_REGION`, instead of always to `us-west-2`. `AWS_REGION` is required: deploy fails with an error that asks for it when it is not set. To keep deploying a project that was deployed before, set `AWS_REGION=us-west-2`.
