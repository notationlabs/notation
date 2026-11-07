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

### JavaScript-native developer toolkit for cloud-native deployments

Notation is an experimental serverless toolkit designed for JavaScript's culture and ecosystem.

[Website](https://notation.dev)<sup>↗</sup>&nbsp;•&nbsp;
[Quick Start](#quick-start)<sup>↓</sup>&nbsp;•&nbsp;
[Slow Start](https://notation.dev/docs/guide)<sup>↗</sup>&nbsp;•&nbsp;
[Examples](https://github.com/notation-dev/notation/tree/main/examples)&nbsp;•&nbsp;
[Discord](https://discord.gg/mGzDWShPzm)<sup>↗</sup>&nbsp;•&nbsp;
[Twitter](https://twitter.com/notation_dev)<sup>↗</sup>

<br />

## Features

### Infrastructure compiler

Generates cloud implementation details from intuitive-to-write code.

Using inference and best practices, compiles policy documents, ARN strings, IAM roles, permissions etc.

<img alt="Notation infra graph" src=".github/assets/code-infra-graph.png">

<br />

### Hot infra replacement

Deploys both production and ephemeral dev stacks.

Built from the ground up and designed for fast iteration cycles, hot infra replacement updates live dev stacks while you code.

https://github.com/notation-dev/notation/assets/1670902/fd8c955f-8aa9-4800-813a-ea96c2b398cc

### End-to-end types

Brings together popular serverless technologies in a unified type space.

Provides well-designed types for every resource, and ensures compatibility between infrastructure and runtime modules.

<img alt="Notation TS error" src=".github/assets/code-error.png">

## Quick Start

Notation requires Node.js 22 or later.

```sh
npm create notation@alpha my-app
```

See also: [Getting Started Guide](https://notation.dev/docs/guide)<sup>↗</sup>

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

## Questions and Feedback

Feel free to book a call to discuss Notation. We'd love to hear your feedback or answer any questions you have.

<a href="https://cal.com/djgrant/notation-chat"><img alt="Book us with Cal.com" src="https://cal.com/book-with-cal-dark.svg" /></a>

## License

[Apache 2.0](https://choosealicense.com/licenses/apache-2.0/)
