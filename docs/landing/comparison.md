### Notation

::code-group

```ts [infra/api.ts]
import { api, router } from "notation/aws/api-gateway";
import { getTodos } from "../runtime/todos.fn";

const todoApi = api({ name: "todo-api" });
const todoRouter = router(todoApi);

todoRouter.get("/todos", getTodos);
```

```ts [runtime/todos.fn.ts]
import { handle, json } from "notation/aws/lambda.fn";

export const getTodos = handle.apiRequest(() => {
  return json([{ id: 1, text: "Learn Notation" }]);
});

export const config = {
  service: "aws-lambda",
  timeout: 5,
  memory: 64,
};
```

::

### CDK

::code-group

```ts [stack.ts]
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const getTodos = new lambda.Function(this, "GetTodos", {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromAsset("dist"),
      handler: "todos.handler",
    });

    const api = new apigw.RestApi(this, "TodoApi");

    const todos = api.root.addResource("todos");
    todos.addMethod("GET", new apigw.LambdaIntegration(getTodos));
  }
}
```

```ts [dist/todos.ts]
export const handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify([{ id: 1, text: "Learn CDK" }]),
  };
};
```

::

### Pulumi

::code-group

```ts [index.ts]
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const role = new aws.iam.Role("lambda-role", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: "lambda.amazonaws.com",
  }),
});

new aws.iam.RolePolicyAttachment("lambda-basic-execution", {
  role: role.name,
  policyArn: aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole,
});

const fn = new aws.lambda.Function("getTodos", {
  runtime: "nodejs18.x",
  role: role.arn,
  handler: "todos.handler",
  code: new pulumi.asset.AssetArchive({
    ".": new pulumi.asset.FileArchive("./dist"),
  }),
});

const api = new awsx.apigateway.API("todo-api", {
  routes: [
    {
      path: "/todos",
      method: "GET",
      eventHandler: fn,
    },
  ],
});
```

```ts [dist/todos.ts]
export const handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify([{ id: 1, text: "Learn Pulumi" }]),
  };
};
```

::

### SST

::code-group

```ts [sst.config.ts]
export default $config({
  app(input) {
    return {
      name: "todo-app",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    const api = new sst.aws.ApiGatewayV2("Api");

    api.route("GET /todos", {
      handler: "src/todos.handler",
    });

    return {
      url: api.url,
    };
  },
});
```

```ts [src/todos.ts]
export async function handler() {
  return {
    statusCode: 200,
    body: JSON.stringify([{ id: 1, text: "Learn SST" }]),
  };
}
```

::

### Serverless

::code-group

```yaml [serverless.yml]
service: todo-api

provider:
  name: aws
  runtime: nodejs18.x

functions:
  getTodos:
    handler: src/todos.handler
    events:
      - httpApi:
          path: /todos
          method: get
```

```ts [src/todos.ts]
export const handler = async () => {
  return {
    statusCode: 200,
    body: JSON.stringify([{ id: 1, text: "Learn Serverless" }]),
  };
};
```

::
