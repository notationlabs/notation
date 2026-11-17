---
"@notation/cloudflare": patch
---

`ContainerImage` retries a create when the registry can't be reached. When `docker login` or `docker push` fails with a network error, such as `net/http: timeout awaiting response headers`, or with a 500, 502, 503, 504 or one of Cloudflare's 520–524, create throws `ResourceCreationUnknownError`. The same happens when a Cloudflare API request in create fails on the network or with a 5xx. The reconciler then reads the tag from the registry. If the image is there, deploy records it without pushing again. If not, deploy calls create again, which builds from Docker's cache and pushes only the layers that the registry doesn't have. Deploy makes up to 10 such attempts, 1 second apart, and a read of the tag that fails on the network also counts as one. After the last one, the deploy fails. A push that the registry rate limits is retried after 5 seconds, up to 30 times. A push that the registry refuses, such as `denied`, still fails the deploy.

The error of a failed Docker command no longer holds layer progress lines such as `076cba098ace: Waiting`. It holds the end of stdout, then the end of stderr, so the reason for the failure comes last. The CLI no longer prints the output again as an `output` property after the error.
