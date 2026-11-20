<h1>
  <a href="https://www.notation.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/notation-logo-dark.svg" height="40">
      <source media="(prefers-color-scheme: light)" srcset=".github/assets/notation-logo.svg" height="40">
      <img alt="Notation Logo" src=".github/assets/notation-logo.svg" height="40" />
    </picture>
  </a>    
  <br />
  <a href="https://github.com/notation_dev/notation/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202-blue" /></a>
  <a href="https://www.npmjs.com/package/@notation/core"><img src="https://img.shields.io/npm/v/@notation/core.svg?style=flat" /></a>
  <a href="https://github.com/notation-dev/notation/discussions"><img alt="Discussions" src="https://img.shields.io/github/discussions/notation-dev/notation"/></a>
  <a href="https://discord.gg/mGzDWShPzm"><img alt="Discord" src="https://img.shields.io/discord/1154880135678406676"></a>
</h1>

Notation Deploy lets you ship infrastructure and application code as one TypeScript project. 

[Website](https://notation.dev)<sup>↗</sup>&nbsp;•&nbsp;
[Quick Start](#quick-start)<sup>↓</sup>&nbsp;•&nbsp;
[Slow Start](https://notation.dev/docs)<sup>↗</sup>&nbsp;•&nbsp;
[Features](#features)<sup>↓</sup>&nbsp;•&nbsp;
[Examples](https://github.com/notation-dev/notation/tree/main/examples)&nbsp;•&nbsp;

## Features

- **End-to-end types**: request schemas, bindings, environment variables and secrets declared in infrastructure code are typed in runtime handlers.
- **Dual compilation**: one build pass evaluates the infrastructure graph; another bundles each function without deploy-time SDKs.
- **Safe deployments**: `notation plan` checks for drift against live cloud APIs, and interrupted deploys resume from the last checkpoint.
- **Secrets**: credentials from environment variables, `.env` files or Infisical are wired into resources without plaintext values reaching state, plans or logs.
- **Watch mode**: `notation watch` rebuilds and redeploys a dev stage as you edit.
- **Providers**: AWS (e.g. Lambda, API Gateway, SQS, EventBridge) and Cloudflare (e.g. Workers, Durable Objects, Containers, KV, R2).

## Quick Start

```sh
npm create notation@alpha my-app
```

See also: [Getting Started Guide](https://notation.dev/docs)<sup>↗</sup>

## Demo

A walkthrough of the key features of Notation.

<a href="https://www.youtube.com/watch?v=dwS81CVkC88">
<img alt="Notation demo thumbnail" src=".github/assets/video-thumbnail.png" width="600">
</a>

## Community

- **[Discussions](https://github.com/notation-dev/notation/discussions)**: ask questions, give feedback on RFCs, suggest ideas
- **[Issues](https://github.com/notation-dev/notation/issues/new)**: report bugs,
  suggest new features, or help us improve the docs
- **[Discord](https://discord.gg/mGzDWShPzm)<sup>↗</sup>**: ask for advice, share your projects,
  discuss contributions

## License

[Apache 2.0](https://choosealicense.com/licenses/apache-2.0/)
