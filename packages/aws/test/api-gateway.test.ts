import { test, expect, expectTypeOf } from "vitest";
import {
  collectResourceGraph as collect,
  type ResourceGraph,
  type StandardSchemaV1,
} from "@notation/resource";
import { api, jwtAuthorizer, router } from "src/api-gateway";
import { route, RouteGroup } from "src/api-gateway/route";
import {
  $lambda,
  apiGateway,
  lambda,
  sqs,
  type JwtClaims,
  type LambdaGroup,
  type LambdaHandler,
} from "src/lambda";
import { queue } from "src/sqs";
import { inModule, lambdaGroup, Unknown } from "./declare";

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
  await collect(() => {
    const apiResourceGroup = api({ id: "api" });
    fn = declareLambda();
    route(apiResourceGroup, "GET", "/hello", undefined, fn);
    route(apiResourceGroup, "POST", "/hello", undefined, fn);
  });

  expect(fn.resources.map((r) => r.id)).toEqual(
    expect.arrayContaining([
      "api-integration:api:handler",
      "api-permission:api:handler",
    ]),
  );
  expect(fn.resources).toHaveLength(7);
});

test("router provides methods for each HTTP verb", async () => {
  const methods = ["get", "post", "put", "delete", "patch"] as const;
  const graph = await collect(() => {
    const apiRouter = router(api({ id: "api" }));
    const handler = declareLambda();
    for (const method of methods) apiRouter[method]("/hello", handler);
  });

  for (const method of methods) {
    const verb = method.toUpperCase();
    expect(
      routeGroup(graph, `api-route:api:${verb} /hello`).route.config.RouteKey,
    ).toEqual(`${verb} /hello`);
  }
});

test("api and route groups are identified by the api name and route", async () => {
  let todoApi!: ReturnType<typeof api>;
  const graph = await collect(() => {
    todoApi = api({ id: "todo-api" });
    route(todoApi, "GET", "/todos", undefined, declareLambda());
  });
  const todoRoute = routeGroup(graph, "api-route:todo-api:GET /todos");

  expect(todoApi.id).toBe("todo-api");
  expect(todoRoute.route.group).toEqual({
    type: "API Gateway/Route",
    id: "api-route:todo-api:GET /todos",
  });
});

test("declaring the same route twice in one deployment throws", async () => {
  await expect(
    collect(() => {
      const handler = declareLambda();
      const todoApi = api({ id: "todo-api" });
      route(todoApi, "GET", "/todos", undefined, handler);
      route(todoApi, "GET", "/todos", undefined, handler);
    }),
  ).rejects.toThrow(
    'Duplicate API Gateway/Route id "api-route:todo-api:GET /todos"',
  );
});

test("a lambda routed from two apis gets an integration per api", async () => {
  const graph = await collect(() => {
    const handler = declareLambda();
    route(api({ id: "a" }), "GET", "/x", undefined, handler);
    route(api({ id: "b" }), "GET", "/x", undefined, handler);
  });

  const integrationA = routeGroup(graph, "api-route:a:GET /x").route
    .dependencies.lambdaIntegration;
  const integrationB = routeGroup(graph, "api-route:b:GET /x").route
    .dependencies.lambdaIntegration;

  expect(integrationA.dependencies.api.id).toBe("api:a");
  expect(integrationB.dependencies.api.id).toBe("api:b");
});

test("routes of one authorizer share its RouteAuth, which the authorizer owns", async () => {
  const graph = await collect(() => {
    const handler = declareLambda();
    const userApi = api({ id: "user-api" });
    const userAuth = jwtAuthorizer({
      id: "user-auth",
      api: userApi,
      issuer: "https://issuer.example/",
      audience: ["https://api.example"],
      scopes: ["write"],
    });
    const otherAuth = jwtAuthorizer({
      id: "other-auth",
      api: userApi,
      issuer: "https://issuer.example/",
      audience: ["other"],
    });
    route(userApi, "GET", "/a", userAuth, handler);
    route(userApi, "POST", "/b", userAuth, handler);
    route(userApi, "GET", "/c", otherAuth, handler);
  });
  const routeOf = (id: string) => routeGroup(graph, id).route;
  const authA = routeOf("api-route:user-api:GET /a").dependencies.auth;

  expect(routeOf("api-route:user-api:POST /b").dependencies.auth).toBe(authA);
  expect(routeOf("api-route:user-api:GET /c").dependencies.auth).not.toBe(
    authA,
  );
  expect(authA?.group).toEqual({
    type: "API Gateway/JWT Authorizer",
    id: "api-authorizer:user-api:user-auth",
  });
  expect(authA?.id).toBe("api-authorizer:user-api:user-auth");
  expect(authA?.config.Name).toBe("user-auth");
  expect(routeOf("api-route:user-api:GET /a").config).toMatchObject({
    AuthorizationType: "JWT",
    AuthorizationScopes: ["write"],
  });
  expect(
    routeOf("api-route:user-api:GET /c").config.AuthorizationScopes,
  ).toEqual([]);
});

test("two authorizers with the same issuer and audience on one api are allowed when their ids differ", async () => {
  const graph = await collect(() => {
    const userApi = api({ id: "user-api" });
    const config = { api: userApi, issuer: "https://i", audience: ["a"] };
    jwtAuthorizer({ id: "first-auth", ...config });
    jwtAuthorizer({ id: "second-auth", ...config });
  });
  const ids = graph.resources
    .filter((r) => r.group?.type === "API Gateway/JWT Authorizer")
    .map((r) => r.id);

  expect(ids).toEqual([
    "api-authorizer:user-api:first-auth",
    "api-authorizer:user-api:second-auth",
  ]);
});

test("a second authorizer with the same id throws", async () => {
  await expect(
    collect(() => {
      const userApi = api({ id: "user-api" });
      jwtAuthorizer({
        id: "auth",
        api: userApi,
        issuer: "https://a",
        audience: ["a"],
      });
      jwtAuthorizer({
        id: "auth",
        api: userApi,
        issuer: "https://b",
        audience: ["b"],
      });
    }),
  ).rejects.toThrow(
    'Duplicate API Gateway/JWT Authorizer id "api-authorizer:user-api:auth"',
  );
});

test("an authorizer whose AWS name is another's on the same api throws, and names both declarations", async () => {
  await expect(
    collect(() => {
      const userApi = api({ id: "user-api" });
      const config = { api: userApi, issuer: "https://i", audience: ["a"] };
      jwtAuthorizer({ id: "users", ...config });
      jwtAuthorizer({ id: "admins", name: "users", ...config });
    }),
  ).rejects.toThrow(
    'jwtAuthorizer({ id: "users" }) and jwtAuthorizer({ id: "admins", name: "users" }) give two JWT authorizers of the API "user-api" the same AWS name, "users".',
  );
});

test("authorizers on different apis can share an AWS name", async () => {
  await expect(
    collect(() => {
      const config = { issuer: "https://i", audience: ["a"] };
      jwtAuthorizer({ id: "users", api: api({ id: "a" }), ...config });
      jwtAuthorizer({
        id: "admins",
        name: "users",
        api: api({ id: "b" }),
        ...config,
      });
    }),
  ).resolves.toBeDefined();
});

test("two apis can each have an authorizer with the id users", async () => {
  const graph = await collect(() => {
    const config = { issuer: "https://i", audience: ["a"] };
    jwtAuthorizer({ id: "users", api: api({ id: "a" }), ...config });
    jwtAuthorizer({ id: "users", api: api({ id: "b" }), ...config });
  });
  const authorizers = graph.resourceGroups.filter(
    (g) => g.type === "API Gateway/JWT Authorizer",
  );

  expect(authorizers.map((g) => g.id)).toEqual([
    "api-authorizer:a:users",
    "api-authorizer:b:users",
  ]);
  expect(authorizers.map((g) => g.resources[0]?.id)).toEqual([
    "api-authorizer:a:users",
    "api-authorizer:b:users",
  ]);
});

test("changing an authorizer's issuer or audience keeps its id", async () => {
  const authorizerWith = (issuer: string, audience: string[]) =>
    collect(() => {
      jwtAuthorizer({
        id: "user-auth",
        api: api({ id: "user-api" }),
        issuer,
        audience,
      });
    }).then((graph) =>
      graph.resources.find(
        (r) => r.group?.type === "API Gateway/JWT Authorizer",
      )!,
    );
  const before = await authorizerWith("https://old", ["a"]);
  const after = await authorizerWith("https://new", ["b"]);

  expect(after.id).toBe(before.id);
  expect(after.config.JwtConfiguration).toEqual({
    Issuer: "https://new",
    Audience: ["b"],
  });
});

test("an authorizer's name overrides its AWS name", async () => {
  const graph = await collect(() => {
    jwtAuthorizer({
      id: "user-auth",
      name: "users",
      api: api({ id: "user-api" }),
      issuer: "https://i",
      audience: ["a"],
    });
  });
  const auth = graph.resources.find(
    (r) => r.group?.type === "API Gateway/JWT Authorizer",
  )!;

  expect(auth.id).toBe("api-authorizer:user-api:user-auth");
  expect(auth.config.Name).toBe("users");
});

test("jwtAuthorizer() rejects an id that is not name-safe", () => {
  const userApi = api({ id: "user-api" });
  expect(() =>
    jwtAuthorizer({
      // @ts-expect-error dots are not name-safe
      id: "bad.id",
      api: userApi,
      issuer: "https://i",
      audience: [],
    }),
  ).toThrow('Invalid jwtAuthorizer() id "bad.id"');
});

test("jwtAuthorizer() takes the claims type explicitly", () => {
  const userApi = api({ id: "user-api" });
  const config = { api: userApi, issuer: "https://i", audience: ["a"] };
  const userAuth = jwtAuthorizer<typeof Claims>({
    id: "users",
    claims: Claims,
    ...config,
  });
  expectTypeOf(userAuth.claims).toEqualTypeOf<typeof Claims>();

  // An explicit claims type leaves the id to the runtime check.
  expect(() =>
    jwtAuthorizer<typeof Claims>({ id: "bad.id", claims: Claims, ...config }),
  ).toThrow('Invalid jwtAuthorizer() id "bad.id"');

  const id: string = "admins";
  // @ts-expect-error a plain string can't be checked
  jwtAuthorizer({ id, claims: Claims, ...config });
});

test("withAuthorizer() of an authorizer on another api throws", () => {
  const userAuth = jwtAuthorizer({
    id: "user-auth",
    api: api({ id: "user-api" }),
    issuer: "https://i",
    audience: ["a"],
  });
  expect(() =>
    router(api({ id: "todo-api" })).withAuthorizer(userAuth),
  ).toThrow(
    'withAuthorizer() takes an authorizer of the API "todo-api", but the authorizer is on the API "user-api".',
  );
});

test("a route to a lambda group from lambda() sets no environment", async () => {
  let fn!: LambdaGroup;
  await collect(() => {
    fn = lambda({
      id: "hello",
      handler: "main",
      code: { type: "file", path: "external/hello.mjs" },
    });
    router(api({ id: "hello-api" })).get("/hello", fn);
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
  const graph = await collect(() => {
    const todos = inModule(
      $lambda({ id: "todos", event: () => apiGateway.schema(null) }),
    );
    const plain = inModule($lambda({ id: "plain" }), "runtime/plain.ts");
    const todoRouter = router(api({ id: "todo-api" }));
    todoRouter.get("/todos", () => todos);
    todoRouter.get("/plain", () => plain);
  });

  const integration = routeGroup(graph, "api-route:todo-api:GET /todos").route
    .dependencies.lambdaIntegration;
  expect(integration.dependencies.lambda).toBe(lambdaGroup(graph, "todos").fn);
  expect(
    routeGroup(graph, "api-route:todo-api:GET /plain").route.dependencies
      .lambdaIntegration.dependencies.lambda,
  ).toBe(lambdaGroup(graph, "plain").fn);
});

test("a route to a declaration with an sqs event throws", async () => {
  await expect(
    collect(() => {
      const orders = queue({ id: "orders", schema: Unknown });
      const fn = inModule(
        $lambda({ id: "process", event: () => sqs.bind(orders) }),
      );
      // @ts-expect-error a route can't serve a function of SQS messages
      router(api({ id: "todo-api" })).get("/todos", () => fn);
    }),
  ).rejects.toThrow(
    'route() sends apiGateway events, but the Lambda "process" is declared with event: () => sqs.bind(queue).',
  );
});

type ClaimsType = { sub: string };
type OtherClaimsType = { email: string };

const schemaOf = <T>(check: (value: any) => boolean, message: string) =>
  ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) =>
        check(value) ? { value: value as T } : { issues: [{ message }] },
    },
  }) as StandardSchemaV1<unknown, T>;

const Claims = schemaOf<ClaimsType>(
  (v) => typeof v?.sub === "string",
  "sub must be a string",
);
const OtherClaims = schemaOf<OtherClaimsType>(
  (v) => typeof v?.email === "string",
  "email must be a string",
);

const authorizerOn = <C extends StandardSchemaV1 | undefined = undefined>(
  apiGroup: ReturnType<typeof api>,
  claims?: C,
) =>
  jwtAuthorizer({
    // Each API in these tests has one authorizer, named after the API.
    id: `${apiGroup.id}-auth` as "auth",
    api: apiGroup,
    issuer: "https://auth.example.com/",
    audience: ["https://api.example.com"],
    claims,
  });

test("a route with an authorizer integrates a declaration with the authorizer's claims schema", async () => {
  const graph = await collect(() => {
    const user = inModule(
      $lambda({
        id: "user",
        event: () => apiGateway.schema(null).authSchema(Claims),
      }),
    );
    const userApi = api({ id: "user-api" });
    router(userApi)
      .withAuthorizer(authorizerOn(userApi, Claims))
      .get("/user", () => user);
  });

  expect(
    routeGroup(graph, "api-route:user-api:GET /user").route.dependencies
      .lambdaIntegration.dependencies.lambda,
  ).toBe(lambdaGroup(graph, "user").fn);
});

test("a route with an authorizer with no claims schema integrates a declaration with any claims schema", async () => {
  const graph = await collect(() => {
    const user = inModule(
      $lambda({
        id: "user",
        event: () => apiGateway.schema(null).authSchema(Claims),
      }),
    );
    const userApi = api({ id: "user-api" });
    router(userApi)
      .withAuthorizer(authorizerOn(userApi))
      .get("/user", () => user);
  });

  expect(routeGroup(graph, "api-route:user-api:GET /user")).toBeDefined();
});

test("a route with an authorizer whose claims schema is another object than the declaration's throws", async () => {
  const Copy: typeof Claims = { "~standard": { ...Claims["~standard"] } };
  await expect(
    collect(() => {
      const user = inModule(
        $lambda({
          id: "user",
          event: () => apiGateway.schema(null).authSchema(Claims),
        }),
      );
      const userApi = api({ id: "user-api" });
      router(userApi)
        .withAuthorizer(authorizerOn(userApi, Copy))
        .get("/user", () => user);
    }),
  ).rejects.toThrow(
    `route() routes GET /user to the Lambda "user", but the authorizer's claims schema is not the claims schema of the Lambda's event: () => apiGateway.schema(body).authSchema(claims), so the function would validate the claims with another schema. Give jwtAuthorizer() and authSchema() the same claims schema, imported from a shared module.`,
  );
});

test("a route with an authorizer integrates a declaration with authSchema() and no claims schema", async () => {
  const graph = await collect(() => {
    const user = inModule(
      $lambda({
        id: "user",
        event: () => apiGateway.schema(null).authSchema(),
      }),
    );
    const plain = inModule(
      $lambda({
        id: "plain",
        event: () => apiGateway.schema(null).authSchema(),
      }),
    );
    const userApi = api({ id: "user-api" });
    router(userApi)
      .withAuthorizer(authorizerOn(userApi, Claims))
      .get("/user", () => user);
    const plainApi = api({ id: "plain-api" });
    router(plainApi)
      .withAuthorizer(authorizerOn(plainApi))
      .get("/plain", () => plain);
  });

  expect(routeGroup(graph, "api-route:user-api:GET /user")).toBeDefined();
  expect(routeGroup(graph, "api-route:plain-api:GET /plain")).toBeDefined();
});

test("a route without an authorizer to a declaration with authSchema() and no claims schema throws", async () => {
  await expect(
    collect(() => {
      const user = inModule(
        $lambda({
          id: "user",
          event: () => apiGateway.schema(null).authSchema(),
        }),
      );
      // @ts-expect-error the declaration expects the claims
      router(api({ id: "user-api" })).get("/user", () => user);
    }),
  ).rejects.toThrow(
    'route() sends apiGateway events, but the Lambda "user" is declared with event: () => apiGateway.schema(body).authSchema().',
  );
});

test("a route with an authorizer rejects a declaration whose claims schema type is not the authorizer's", () => {
  const user = $lambda({
    id: "user",
    event: () => apiGateway.schema(null).authSchema(Claims),
  });
  const other = $lambda({
    id: "other",
    event: () => apiGateway.schema(null).authSchema(OtherClaims),
  });
  const userApi = api({ id: "user-api" });
  const authed = router(userApi).withAuthorizer(authorizerOn(userApi, Claims));
  const loose = router(userApi).withAuthorizer(
    jwtAuthorizer({
      id: "loose-auth",
      api: userApi,
      issuer: "https://other",
      audience: ["a"],
    }),
  );

  const any = $lambda({
    id: "any",
    event: () => apiGateway.schema(null).authSchema(),
  });

  // The calls are only type-checked.
  const typeOnly = () => {
    authed.get("/user", () => user);
    authed.get("/any", () => any);
    loose.get("/other", () => other);
    loose.get("/any", () => any);
    // @ts-expect-error the declaration validates other claims than the authorizer's
    authed.get("/other", () => other);
  };
  void typeOnly;
});

test("a route without an authorizer to a declaration with claims throws", async () => {
  await expect(
    collect(() => {
      const user = inModule(
        $lambda({
          id: "user",
          event: () => apiGateway.schema(null).authSchema(Claims),
        }),
      );
      // @ts-expect-error the request has no claims
      router(api({ id: "user-api" })).get("/user", () => user);
    }),
  ).rejects.toThrow(
    'route() sends apiGateway events, but the Lambda "user" is declared with event: () => apiGateway.schema(body).authSchema(claims).',
  );
});

test("a route with an authorizer to a declaration with no claims throws", async () => {
  await expect(
    collect(() => {
      const todos = inModule(
        $lambda({ id: "todos", event: () => apiGateway.schema(null) }),
      );
      const todoApi = api({ id: "todo-api" });
      router(todoApi)
        .withAuthorizer(authorizerOn(todoApi))
        // @ts-expect-error the declaration doesn't expect the claims
        .get("/todos", () => todos);
    }),
  ).rejects.toThrow(
    'route() sends apiGateway events with a JWT authorizer, but the Lambda "todos" is declared with event: () => apiGateway.schema(body).',
  );
});

test("route rejects a value that is not a declaration or a lambda group", () => {
  expect(() =>
    route(api({ id: "todo-api" }), "GET", "/todos", undefined, {
      resource: {},
      export: "getTodos",
    } as any),
  ).toThrow("route() expects a function that returns a Lambda declaration");
});

test("routes behind a jwt authorizer take only functions of HTTP requests", async () => {
  await expect(
    collect(() => {
      const orders = queue({ id: "orders", schema: Unknown });
      const fn = inModule(
        $lambda({ id: "process", event: () => sqs.bind(orders) }),
      );
      const todoApi = api({ id: "todo-api" });
      const authed = router(todoApi).withAuthorizer(authorizerOn(todoApi));
      // @ts-expect-error a route can't serve a function of SQS messages
      authed.get("/process", () => fn);
    }),
  ).rejects.toThrow(
    'the Lambda "process" is declared with event: () => sqs.bind(queue)',
  );
});

test("apiGateway.bind(api).defineRoute() in a declaration makes the route", async () => {
  const graph = await collect(() => {
    const todoApi = api({ id: "todo-api" });
    inModule(
      $lambda({
        id: "todos",
        event: () =>
          apiGateway
            .bind(todoApi)
            .defineRoute({ method: "GET", path: "/todos", schema: null }),
      }),
    );
  });
  const todos = routeGroup(graph, "api-route:todo-api:GET /todos").route;

  expect(todos.config).toMatchObject({
    RouteKey: "GET /todos",
    AuthorizationType: "NONE",
  });
  expect(todos.dependencies.lambdaIntegration.dependencies.lambda).toBe(
    lambdaGroup(graph, "todos").fn,
  );
  expect(todos.dependencies.auth).toBeUndefined();
});

test("apiGateway.bind(api).defineRoute({ auth }) makes the route with the authorizer, and decode() validates with its claims schema", async () => {
  let userAuth!: ReturnType<typeof authorizerOn<typeof Claims>>;
  let user!: ReturnType<typeof declareUser>;
  const declareUser = (auth: typeof userAuth) =>
    $lambda({
      id: "user",
      event: () =>
        apiGateway
          .bind(auth.api)
          .defineRoute({ method: "POST", path: "/user", schema: null, auth }),
    });
  const graph = await collect(() => {
    userAuth = authorizerOn(api({ id: "user-api" }), Claims);
    user = inModule(declareUser(userAuth));
  });
  const userRoute = routeGroup(graph, "api-route:user-api:POST /user").route;

  expect(userRoute.config.AuthorizationType).toBe("JWT");
  expect(userRoute.dependencies.auth).toBe(userAuth.auth);
  const request = (claims: unknown) => ({
    body: undefined,
    isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims } } },
  });
  await expect(user.decode(request({ sub: "u1" }))).resolves.toMatchObject({
    body: undefined,
    claims: { sub: "u1" },
  });
  await expect(user.decode(request({}))).rejects.toThrow(
    "sub must be a string",
  );
});

test("apiGateway.bind(api).defineRoute() types the event from its options", () => {
  const userApi = api({ id: "user-api" });
  const userAuth = authorizerOn(userApi, Claims);
  const user = $lambda({
    id: "user",
    event: () =>
      apiGateway.bind(userApi).defineRoute({
        method: "POST",
        path: "/user",
        schema: OtherClaims,
        auth: userAuth,
      }),
  });
  const plain = $lambda({
    id: "plain",
    event: () =>
      apiGateway
        .bind(userApi)
        .defineRoute({ method: "GET", path: "/plain", schema: null }),
  });

  expectTypeOf<
    NonNullable<(typeof user)["~lambda"]>["kind"]
  >().toEqualTypeOf<"apiGateway-jwt">();
  expectTypeOf<
    NonNullable<(typeof user)["~lambda"]>["event"]["claims"]
  >().toEqualTypeOf<typeof Claims>();
  type UserEvent = Parameters<LambdaHandler<typeof user>>[0];
  const decodeUser = (event: UserEvent) => user.decode(event);
  type Decoded = Awaited<ReturnType<typeof decodeUser>>;
  expectTypeOf<Decoded["body"]>().toEqualTypeOf<OtherClaimsType>();
  expectTypeOf<Decoded["claims"]>().toEqualTypeOf<ClaimsType>();
  expectTypeOf<
    Parameters<
      LambdaHandler<typeof user>
    >[0]["requestContext"]["authorizer"]["jwt"]["claims"]
  >().toEqualTypeOf<JwtClaims>();
  expectTypeOf<
    NonNullable<(typeof plain)["~lambda"]>["kind"]
  >().toEqualTypeOf<"apiGateway">();

  // Only type-checked.
  const typeOnly = () => {
    // @ts-expect-error a schema is not an API
    apiGateway.bind(Claims);
    apiGateway.bind(userApi).defineRoute({
      method: "GET",
      path: "/user",
      schema: null,
      // @ts-expect-error a schema is not an authorizer
      auth: Claims,
    });
    apiGateway
      .bind(userApi)
      // @ts-expect-error defineRoute() needs a schema, or null for no body
      .defineRoute({ method: "GET", path: "/user" });
  };
  void typeOnly;
});

test("decode() reads the claims schema from the object that the runtime build passes", async () => {
  const fn = $lambda({
    id: "user",
    // The runtime build replaces the API with {} and the authorizer with its
    // runtime options.
    event: () =>
      apiGateway.bind({} as any).defineRoute({
        method: "GET",
        path: "/user",
        schema: null,
        auth: { claims: Claims },
      }),
  });

  await expect(
    fn.decode({
      body: undefined,
      isBase64Encoded: false,
      requestContext: { authorizer: { jwt: { claims: {} } } },
    }),
  ).rejects.toThrow("sub must be a string");
});

test("route() of a declaration that makes its own route throws", async () => {
  await expect(
    collect(() => {
      const todoApi = api({ id: "todo-api" });
      const todos = inModule(
        $lambda({
          id: "todos",
          event: () =>
            apiGateway
              .bind(todoApi)
              .defineRoute({ method: "GET", path: "/todos", schema: null }),
        }),
      );
      router(todoApi).get("/todos/all", () => todos);
    }),
  ).rejects.toThrow(
    'route() routes GET /todos/all to the Lambda "todos", which makes its own route in its declaration, with event: () => apiGateway.bind(api).defineRoute(options). Route the Lambda in one place: remove the route() call, or declare the Lambda with event: () => apiGateway.schema(body).',
  );
});

test("apiGateway.bind(api).defineRoute({ auth }) with an authorizer on another api throws", async () => {
  await expect(
    collect(() => {
      const userAuth = authorizerOn(api({ id: "user-api" }));
      const todoApi = api({ id: "todo-api" });
      inModule(
        $lambda({
          id: "todos",
          event: () =>
            apiGateway.bind(todoApi).defineRoute({
              method: "GET",
              path: "/todos",
              schema: null,
              auth: userAuth,
            }),
        }),
      );
    }),
  ).rejects.toThrow(
    'The Lambda "todos" routes GET /todos on the API "todo-api", but its authorizer is on the API "user-api".',
  );
});

test("apiGateway.bind() of a value that is not an API throws when the declaration is built", async () => {
  await expect(
    collect(() => {
      inModule(
        $lambda({
          id: "todos",
          event: () =>
            apiGateway
              .bind({} as any)
              .defineRoute({ method: "GET", path: "/todos", schema: null }),
        }),
      );
    }),
  ).rejects.toThrow(
    'The Lambda "todos" is declared with apiGateway.bind(api), but the value passed to apiGateway.bind() is not an API from api().',
  );
});
