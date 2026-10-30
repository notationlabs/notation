import { test, expect } from "vitest";
import { collectResourceGraph } from "@notation/resource";
import { NO_AUTH, api, router } from "src/api-gateway";
import { route } from "src/api-gateway/route";
import { lambda } from "src/lambda";

test("route resource group idempotency snapshot", () => {
  const apiResourceGroup = api({ name: "api" });
  const fnResourceGroup = lambda({
    id: "handler",
    code: {
      type: "file",
      path: "src/fns/handler.fn.js",
    },
    handler: "handler.fn.js",
  });

  route(apiResourceGroup, "GET", "/hello", NO_AUTH, fnResourceGroup as any);
  const fnResourceGroupSnapshot = JSON.stringify(fnResourceGroup);
  route(apiResourceGroup, "POST", "/hello", NO_AUTH, fnResourceGroup as any);
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
    handler: "handler.fn.js",
  });

  for (const method of ["get", "post", "put", "delete", "patch"] as const) {
    const routeGroup = apiRouter[method]("/hello", handler as any);
    const route = routeGroup.route;
    expect(route.config.RouteKey).toEqual(`${method.toUpperCase()} /hello`);
  }
});

test("api and route groups are identified by the api name and route", () => {
  const handler = lambda({
    id: "handler",
    code: { type: "file", path: "src/fns/handler.fn.js" },
    handler: "handler.fn.js",
  });
  const todoApi = api({ name: "todo-api" });
  const todoRoute = route(todoApi, "GET", "/todos", NO_AUTH, handler);

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
        handler: "handler.fn.js",
      });
      const todoApi = api({ name: "todo-api" });
      route(todoApi, "GET", "/todos", NO_AUTH, handler);
      route(todoApi, "GET", "/todos", NO_AUTH, handler);
    }),
  ).rejects.toThrow('Duplicate API Gateway/Route id "todo-api-GET-/todos"');
});

test("a lambda routed from two apis gets an integration per api", () => {
  const handler = lambda({
    id: "handler",
    code: { type: "file", path: "src/fns/handler.fn.js" },
    handler: "handler.fn.js",
  });
  const routeA = route(api({ name: "a" }), "GET", "/x", NO_AUTH, handler);
  const routeB = route(api({ name: "b" }), "GET", "/x", NO_AUTH, handler);

  const integrationA = routeA.route.dependencies.lambdaIntegration;
  const integrationB = routeB.route.dependencies.lambdaIntegration;

  expect(integrationA.dependencies.api.id).toBe("a");
  expect(integrationB.dependencies.api.id).toBe("b");
});

test("routes with the same jwt config share one authorizer per api", () => {
  const handler = lambda({
    id: "handler",
    code: { type: "file", path: "src/fns/handler.fn.js" },
    handler: "handler.fn.js",
  });
  const jwt = {
    type: "jwt" as const,
    issuer: "https://issuer.example/",
    audience: ["https://api.example"],
    scopes: [],
  };
  const userApi = api({ name: "user-api" });
  const routeA = route(userApi, "GET", "/a", jwt, handler);
  const routeB = route(
    userApi,
    "POST",
    "/b",
    { ...jwt, scopes: ["write"] },
    handler,
  );
  const routeC = route(
    userApi,
    "GET",
    "/c",
    { ...jwt, audience: ["other"] },
    handler,
  );
  const routeD = route(api({ name: "other-api" }), "GET", "/a", jwt, handler);

  const authA = routeA.route.dependencies.auth;
  expect(routeB.route.dependencies.auth).toBe(authA);
  expect(routeC.route.dependencies.auth).not.toBe(authA);
  expect(routeD.route.dependencies.auth).not.toBe(authA);
  expect(authA?.group).toEqual({ type: "API Gateway", id: "user-api" });
});
