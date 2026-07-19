import { test, expect } from "vitest";
import { apiGateway } from "@notation/aws.iac";
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
    const route = routeGroup.findResource(apiGateway.Route)!;
    expect(route.config.RouteKey).toEqual(`${method.toUpperCase()} /hello`);
  }
});
