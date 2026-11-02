import { test, expect } from "vitest";
import { collectResourceGraph } from "@notation/resource";
import { NO_AUTH, api, router } from "src/api-gateway";
import { route } from "src/api-gateway/route";
import { lambda, type LambdaGroup } from "src/lambda";

const ref = (resource: LambdaGroup, name = "handler") => ({
  resource,
  export: name,
});

test("route resource group idempotency snapshot", () => {
  const apiResourceGroup = api({ name: "api" });
  const fnResourceGroup = lambda({
    id: "handler",
    code: {
      type: "file",
      path: "src/fns/handler.fn.js",
    },
  });

  route(apiResourceGroup, "GET", "/hello", NO_AUTH, ref(fnResourceGroup));
  const fnResourceGroupSnapshot = JSON.stringify(fnResourceGroup);
  route(apiResourceGroup, "POST", "/hello", NO_AUTH, ref(fnResourceGroup));
  const fnResourceGroupSnapshot2 = JSON.stringify(fnResourceGroup);

  expect(fnResourceGroupSnapshot).toEqual(fnResourceGroupSnapshot2);
});

test("router provides methods for each HTTP verb", () => {
  const apiResourceGroup = api({ name: "api" });
  const apiRouter = router(apiResourceGroup);
  const handler = lambda({
    id: "handler",
    code: {
      type: "file",
      path: "src/fns/handler.fn.js",
    },
  });

  for (const method of ["get", "post", "put", "delete", "patch"] as const) {
    const routeGroup = apiRouter[method]("/hello", ref(handler));
    const route = routeGroup.route;
    expect(route.config.RouteKey).toEqual(`${method.toUpperCase()} /hello`);
  }
});

test("api and route groups are identified by the api name and route", () => {
  const handler = lambda({
    id: "handler",
    code: { type: "file", path: "src/fns/handler.fn.js" },
  });
  const todoApi = api({ name: "todo-api" });
  const todoRoute = route(todoApi, "GET", "/todos", NO_AUTH, ref(handler));

  expect(todoApi.id).toBe("todo-api");
  expect(todoRoute.id).toBe("todo-api-GET-/todos");
  expect(todoRoute.route.group).toEqual({
    type: "API Gateway/Route",
    id: "todo-api-GET-/todos",
  });
});

test("declaring the same route twice in one deployment throws", async () => {
  await expect(
    collectResourceGraph(() => {
      const handler = lambda({
        id: "handler",
        code: { type: "file", path: "src/fns/handler.fn.js" },
      });
      const todoApi = api({ name: "todo-api" });
      route(todoApi, "GET", "/todos", NO_AUTH, ref(handler));
      route(todoApi, "GET", "/todos", NO_AUTH, ref(handler));
    }),
  ).rejects.toThrow('Duplicate API Gateway/Route id "todo-api-GET-/todos"');
});

test("a lambda routed from two apis gets an integration per api", () => {
  const handler = lambda({
    id: "handler",
    code: { type: "file", path: "src/fns/handler.fn.js" },
  });
  const routeA = route(api({ name: "a" }), "GET", "/x", NO_AUTH, ref(handler));
  const routeB = route(api({ name: "b" }), "GET", "/x", NO_AUTH, ref(handler));

  const integrationA = routeA.route.dependencies.lambdaIntegration;
  const integrationB = routeB.route.dependencies.lambdaIntegration;

  expect(integrationA.dependencies.api.id).toBe("a");
  expect(integrationB.dependencies.api.id).toBe("b");
});

test("routes with the same jwt config share one authorizer per api", () => {
  const handler = lambda({
    id: "handler",
    code: { type: "file", path: "src/fns/handler.fn.js" },
  });
  const jwt = {
    type: "jwt" as const,
    issuer: "https://issuer.example/",
    audience: ["https://api.example"],
    scopes: [],
  };
  const userApi = api({ name: "user-api" });
  const routeA = route(userApi, "GET", "/a", jwt, ref(handler));
  const routeB = route(
    userApi,
    "POST",
    "/b",
    { ...jwt, scopes: ["write"] },
    ref(handler),
  );
  const routeC = route(
    userApi,
    "GET",
    "/c",
    { ...jwt, audience: ["other"] },
    ref(handler),
  );
  const routeD = route(
    api({ name: "other-api" }),
    "GET",
    "/a",
    jwt,
    ref(handler),
  );

  const authA = routeA.route.dependencies.auth;
  expect(routeB.route.dependencies.auth).toBe(authA);
  expect(routeC.route.dependencies.auth).not.toBe(authA);
  expect(routeD.route.dependencies.auth).not.toBe(authA);
  expect(authA?.group).toEqual({ type: "API Gateway", id: "user-api" });
});

test("each route adds a dispatch entry keyed by the route's id", async () => {
  let fn!: LambdaGroup;
  let todoApi!: ReturnType<typeof api>;
  await collectResourceGraph(() => {
    fn = lambda({
      id: "todos",
      code: { type: "file", path: "src/fns/todos.js" },
    });
    todoApi = api({ name: "todo-api" });
    route(todoApi, "GET", "/todos", NO_AUTH, ref(fn, "getTodos"));
    route(todoApi, "POST", "/todos", NO_AUTH, ref(fn, "createTodo"));
  });
  todoApi.api.setOutput({ ApiId: "api-1" } as any);
  fn.role.setOutput({ Arn: "arn:role" } as any);
  fn.fn.dependencies.zipFile.setOutput({
    filePath: "todos.zip",
    fileSha256: "sha",
  } as any);

  expect((await fn.fn.getParams()).Environment?.Runtime).toEqual({
    dispatch: {
      "todo-api-GET-/todos": {
        export: "getTodos",
        match: { apiId: "api-1", routeKey: "GET /todos" },
      },
      "todo-api-POST-/todos": {
        export: "createTodo",
        match: { apiId: "api-1", routeKey: "POST /todos" },
      },
    },
  });
  expect(fn.fn.getDependencies()).toContain(todoApi.api);
});

test("a plan shows the api id of a dispatch entry as unknown until the api exists", async () => {
  let fn!: LambdaGroup;
  await collectResourceGraph(() => {
    fn = lambda({
      id: "todos",
      code: { type: "file", path: "src/fns/todos.js" },
    });
    const todoApi = api({ name: "todo-api" });
    route(todoApi, "GET", "/todos", NO_AUTH, ref(fn, "getTodos"));
  });

  const params = await fn.fn.planParams();
  expect(params.Environment).toMatchObject({
    Runtime: {
      dispatch: {
        "todo-api-GET-/todos": {
          export: "getTodos",
          match: {
            apiId: { $unknown: "after-apply" },
            routeKey: "GET /todos",
          },
        },
      },
    },
  });
});

test("route rejects a value that is not a reference to a runtime export", () => {
  const fn = lambda({
    id: "todos",
    code: { type: "file", path: "src/fns/todos.js" },
  });
  expect(() =>
    route(api({ name: "todo-api" }), "GET", "/todos", NO_AUTH, fn as any),
  ).toThrow("route() expects an export of a runtime module");
});
