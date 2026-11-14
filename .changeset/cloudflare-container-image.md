---
"@notation/cloudflare": minor
---

`@notation/cloudflare/resources` exports `cloudflare/containers/ContainerImage`, which builds a container image with Docker and pushes it to the account's Cloudflare registry, `registry.cloudflare.com/<account>/<Repository>`.

- `Context` is the build context directory, and `Dockerfile` defaults to `Dockerfile` in it. Both are relative to the project root. `BuildArgs` are passed to `docker build --build-arg`.
- The output `Image` is the image pinned by its digest. Place `image.outputRef("Image")` in a `ContainerApplication`'s `Configuration.image`. The application then depends on the image.
- The tag is the start of a SHA-256 of the files in the build context, the Dockerfile, the build args and the platform. When any of them changes, deploy replaces the image: it builds and pushes the image under the new tag, then rolls out the new digest to the application. Each `.git` directory is skipped. `.dockerignore` is not read.
- Deploy runs `docker info`, `docker build --load --platform linux/amd64 --provenance=false`, `docker login` and `docker push`. Docker must be installed and running on the machine that deploys. `docker login` saves credentials in the user's Docker config that expire after 15 minutes.
- Each read gets the tag's digest from the registry. A read requests short-lived pull credentials, so plan needs a token with the Containers: Edit permission. When the registry no longer has the tag, deploy builds and pushes the image again.
- Delete leaves the image in the registry, because Cloudflare may still start instances from the old digest while a rollout of the new digest runs.
