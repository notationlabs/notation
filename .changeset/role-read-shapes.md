---
"@notation/aws.iac": patch
---

Stop drift detection from replacing unchanged Lambda IAM roles on every deploy. The role read now decodes the URL-encoded trust policy and returns the permissions boundary as its ARN, and the Lambda function read drops computed fields from `VpcConfig` and `SnapStart`, so reads compare cleanly with configured params.
