---
"@notation/aws": minor
---

`json` is removed from `@notation/aws/lambda.fn`. An API handler can return a plain value, such as an object or an array, and API Gateway sends it as a JSON body with status 200. `ApiGatewayResult` from `@notation/aws/shared` types what an API handler returns.
