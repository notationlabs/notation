---
"@notation/cloudflare": minor
---

`ContainerApplication` takes `Constraints`, and the `container` of a `$durableObject` takes `constraints`, to choose where the containers run: `regions`, such as `["WEUR"]`, and `jurisdiction`, which is `eu`, `us` or `fedramp`. Plan fails for a list of only the limited-capacity regions `ME`, `OC` and `AFR`, and for a region that is not in the jurisdiction. A change to the constraints updates the application without a rollout. Deploy sets back a change to them made outside notation. See [#172](https://github.com/notationlabs/notation/issues/172).
