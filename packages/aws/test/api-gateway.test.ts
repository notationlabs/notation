import { test, expect } from "vitest";
import { collectResourceGraph, type ResourceGraph } from "@notation/resource";
import { NO_AUTH, api, router } from "src/api-gateway";
import { route, RouteGroup } from "src/api-gateway/route";
import type { JWTAuthorizerConfig } from "src/api-gateway/auth";
import {
  $lambda,
  http,
  jwt,
  lambda,
  sqs,
  type LambdaGroup,
} from "src/lambda";
import { inModule, lambdaGroup } from "./declare";

const declareLambda = () =>
  lambda({
    id: "handler",
    code: { type: "file", path: "src/fns/handler.fn.js" },
  });

const routeGroup = (graph: ResourceGraph, id: string) => {
  const group = graph.resourceGroups.find(
    (g): g is RouteGroup => g instanceof RouteGroup && g.id === id,
  );
  if (!group) throw new Error(`No route group ${id} in the graph`);
  return group;
};

test("two routes on one api to one lambda share its integration and permission", async () => {
  let fn!: LambdaGroup;
  await collectResourceGraph(() => {
    const apiResourceGroup = api({ name: "api" });
    fn = declareLambda();
    route(apiResourceGroup, "GET", "/hello", NO_AUTH, fn);
    route(apiResourceGroup, "POST", "/hello", NO_AUTH, fn);
  });

  expect(fn.resources.map((r) => r.id)).toEqual(
    expect.arrayContaining([
      "api-handler-integration",
      "handler-api-permission",
    ]),
  );
  expect(fn.resources).toHaveLength(7);
});

test("router provides methods for each HTTP verb", async () => {
  const methods = ["get", "post", "put", "delete", "patch"] as const;
  const graph = await collectResourceGraph(() => {
    const apiRouter = router(api({ name: "api" }));
    const handler = declareLambda();
    for (const method of methods) apiRouter[method]("/hello", handler);
  });

  for (const method of methods) {
    const verb = method.toUpperCase();
    expect(
      routeGroup(graph, `api-${verb}-/hello`).route.config.RouteKey,
    ).toEqual(`${verb} /hello`);
  }
});

test("api and route groups are identified by the api name and route", async () => {
  let todoApi!: ReturnType<typeof api>;
  const graph = await collectResourceGraph(() => {
    todoApi = api({ name: "todo-api" });
    route(todoApi, "GET", "/todos", NO_AUTH, declareLambda());
  });
  const todoRoute = routeGroup(graph, "todo-api-GET-/todos");

  expect(todoApi.id).toBe("todo-api");
  expect(todoRoute.route.group).toEqual({
    type: "API Gateway/Route",
    id: "todo-api-GET-/todos",
  });
});

test("declaring the same route twice in one deployment throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const handler = declareLambda();
      const todoApi = api({ name: "todo-api" });
      route(todoApi, "GET", "/todos", NO_AUTH, handler);
      route(todoApi, "GET", "/todos", NO_AUTH, handler);
    }),
  ).rejects.toThrow('Duplicate API Gateway/Route id "todo-api-GET-/todos"');
});

test("a lambda routed from two apis gets an integration per api", async () => {
  const graph = await collectResourceGraph(() => {
    const handler = declareLambda();
    route(api({ name: "a" }), "GET", "/x", NO_AUTH, handler);
    route(api({ name: "b" }), "GET", "/x", NO_AUTH, handler);
  });

  const integrationA = routeGroup(graph, "a-GET-/x").route.dependencies
    .lambdaIntegration;
  const integrationB = routeGroup(graph, "b-GET-/x").route.dependencies
    .lambdaIntegration;

  expect(integrationA.dependencies.api.id).toBe("a");
  expect(integrationB.dependencies.api.id).toBe("b");
});

test("routes with the same jwt config share one authorizer per api", async () => {
  const jwt = {
    type: "jwt" as const,
    issuer: "https://issuer.example/",
    audience: ["https://api.example"],
    scopes: [],
  };
  const graph = await collectResourceGraph(() => {
    const handler = declareLambda();
    const userApi = api({ name: "user-api" });
    route(userApi, "GET", "/a", jwt, handler);
    route(userApi, "POST", "/b", { ...jwt, scopes: ["write"] }, handler);
    route(userApi, "GET", "/c", { ...jwt, audience: ["other"] }, handler);
    route(api({ name: "other-api" }), "GET", "/a", jwt, handler);
  });
  const auth = (id: string) => routeGroup(graph, id).route.dependencies.auth;

  const authA = auth("user-api-GET-/a");
  expect(auth("user-api-POST-/b")).toBe(authA);
  expect(auth("user-api-GET-/c")).not.toBe(authA);
  expect(auth("other-api-GET-/a")).not.toBe(authA);
  expect(authA?.group).toEqual({ type: "API Gateway", id: "user-api" });
});

test("a route to a lambda group from lambda() sets no environment", async () => {
  let fn!: LambdaGroup;
  await collectResourceGraph(() => {
    fn = lambda({
      id: "hello",
      handler: "main",
      code: { type: "file", path: "external/hello.mjs" },
    });
    router(api({ name: "hello-api" })).get("/hello", fn);
  });

  fn.role.setOutput({ Arn: "arn:role" } as any);
  fn.fn.dependencies.zipFile.setOutput({
    filePath: "hello.zip",
    fileSha256: "sha",
  } as any);

  expect(fn.fn.config.Handler).toBe("hello.main");
  expect((await fn.fn.getParams()).Environment).toBeUndefined();
});

test("a route to a $lambda declaration integrates its function", async () => {
  const graph = await collectResourceGraph(() => {
    const todos = inModule($lambda({ id: "todos", event: () => http() }));
    const plain = inModule($lambda({ id: "plain" }), "runtime/plain.ts");
    const todoRouter = router(api({ name: "todo-api" }));
    todoRouter.get("/todos", () => todos);
    todoRouter.get("/plain", () => plain);
  });

  const integration = routeGroup(graph, "todo-api-GET-/todos").route
    .dependencies.lambdaIntegration;
  expect(integration.dependencies.lambda).toBe(lambdaGroup(graph, "todos").fn);
  expect(
    routeGroup(graph, "todo-api-GET-/plain").route.dependencies
      .lambdaIntegration.dependencies.lambda,
  ).toBe(lambdaGroup(graph, "plain").fn);
});

test("a route to a declaration with an sqs event throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = inModule($lambda({ id: "process", event: () => sqs() }));
      // @ts-expect-error a route can't serve a function of SQS messages
      router(api({ name: "todo-api" })).get("/todos", () => fn);
    }),
  ).rejects.toThrow(
    'route() sends http events, but the Lambda "process" is declared with event: () => sqs().',
  );
});

const jwtAuth: JWTAuthorizerConfig = {
  type: "jwt",
  issuer: "https://auth.example.com/",
  audience: ["https://api.example.com"],
  scopes: [],
};

test("a route with a JWT authorizer integrates a JWT declaration", async () => {
  const graph = await collectResourceGraph(() => {
    const user = inModule(
      $lambda({ id: "user", event: () => http({ auth: jwt() }) }),
    );
    router(api({ name: "user-api" }))
      .withJWTAuthorizer(jwtAuth)
      .get("/user", () => user);
  });

  expect(
    routeGroup(graph, "user-api-GET-/user").route.dependencies
      .lambdaIntegration.dependencies.lambda,
  ).toBe(lambdaGroup(graph, "user").fn);
});

test("a route without an authorizer to a JWT declaration throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const user = inModule(
        $lambda({ id: "user", event: () => http({ auth: jwt() }) }),
      );
      // @ts-expect-error the request has no claims
      router(api({ name: "user-api" })).get("/user", () => user);
    }),
  ).rejects.toThrow(
    'route() sends http events, but the Lambda "user" is declared with event: () => http({ auth: jwt() }).',
  );
});

test("a route with a JWT authorizer to a plain http declaration throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const todos = inModule($lambda({ id: "todos", event: () => http() }));
      router(api({ name: "todo-api" }))
        .withJWTAuthorizer(jwtAuth)
        // @ts-expect-error the declaration doesn't expect the claims
        .get("/todos", () => todos);
    }),
  ).rejects.toThrow(
    'route() sends http events with a JWT authorizer, but the Lambda "todos" is declared with event: () => http().',
  );
});

test("route rejects a value that is not a declaration or a lambda group", () => {
  expect(() =>
    route(api({ name: "todo-api" }), "GET", "/todos", NO_AUTH, {
      resource: {},
      export: "getTodos",
    } as any),
  ).toThrow("route() expects a function that returns a Lambda declaration");
});

test("routes behind a jwt authorizer take only functions of HTTP requests", async () => {
  await expect(
    collectResourceGraph(() => {
      const fn = inModule($lambda({ id: "process", event: () => sqs() }));
      const authed = router(api({ name: "todo-api" })).withJWTAuthorizer({
        type: "jwt",
        issuer: "https://issuer",
        audience: ["app"],
        scopes: [],
      });
      // @ts-expect-error a route can't serve a function of SQS messages
      authed.get("/process", () => fn);
    }),
  ).rejects.toThrow('the Lambda "process" is declared with event: () => sqs()');
});
