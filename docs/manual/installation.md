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
