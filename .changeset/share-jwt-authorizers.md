---
"@notation/aws": minor
---

Routes on one API with the same JWT issuer and audience share one authorizer instead of one authorizer per route. The authorizer ID changes from `<route id>-<api>-authorizer` to `<api>-jwt-authorizer-<hash>`, and its name from `<api>_<method>_<path>_authorizer` to `<api>_jwt_<hash>`. On the first deploy after the upgrade, each API creates the shared authorizer, points its routes at it and deletes the per-route authorizers. An API that already has 10 authorizers fails the create, because the old authorizers are deleted after it. Ask AWS Support to raise the quota for that API before the upgrade.
