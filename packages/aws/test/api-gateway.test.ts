import { test, expect } from "vitest";
import { NO_AUTH, api, router } from "src/api-gateway";
import { route } from "src/api-gateway/route";
import { lambda } from "src/lambda";

test("route resource group idempotency snapshot", () => {
  const apiResourceGroup = api({ name: "api" });
  const fnResourceGroup = lambda({
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

test("a lambda routed from two apis gets an integration per api", () => {
  const handler = lambda({
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
