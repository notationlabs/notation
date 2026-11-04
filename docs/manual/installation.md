# Installation

## Create a new project

```sh
npm create notation@alpha my-app
```

## Install dependencies

```sh
cd my-app
npm install
```

## Prerequisites

### Node.js

Node.js 18 or later.

```sh
node --version # v18.x or higher
```

Tests that run runtime modules under Node's test runner use Notation's loader hook, which needs Node.js 22.15 or later. See [Testing Handlers](./testing.md).

### TypeScript

TypeScript 7.1 or later, to type-check a project. `notation types` writes `notation-env.d.ts`, which uses import attributes in module declarations, and earlier versions can't parse it. TypeScript 6, Prettier and typescript-eslint can't parse the file either, so exclude it from them. See [notation types](../cli/types.md#tools).

### AWS credentials

Notation deploys to AWS. You need a default profile in `~/.aws/credentials`:

```ini
# ~/.aws/credentials
[default]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
```

To use a named profile instead:

```sh
AWS_PROFILE=my-profile npm run deploy
```

### AWS permissions

Your credentials must have permissions to create and manage:

- Lambda
- API Gateway
- IAM roles and policies
- CloudWatch Logs
