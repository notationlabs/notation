import type { StandardSchemaV1 } from "@notation/resource";
import type {
  APIGatewayEventRequestContextJWTAuthorizer,
  APIGatewayProxyEventV2,
  Context,
  EventBridgeEvent,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from "aws-lambda";
import type { Schedule } from "src/event-bridge/schedule";
import type { LambdaGroup } from "./lambda";
import type { NameSafe } from "src/id";
import type {
  APIGatewayJWTProxyEventV2,
  ApiGatewayResult,
} from "src/shared/lambda.handler";

// This module is part of both builds. In the runtime build it must not import
// infra code, so it imports only types.

/** The function receives SQS messages, which `decode()` validates with `schema`. */
export type SqsEvent<
  S extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  kind: "sqs";
  schema: S;
  /**
   * The queue that the infra build maps to the function, from `sqs.bind()`.
   * It is not set for `sqs.schema()`.
   */
  queue?: SqsSource<S>;
  options?: SqsOptions;
};

/**
 * A queue that `sqs.bind()` reads, from `queue()`. In the function it holds only
 * the queue's schema, as the runtime build replaces the queue with it.
 */
export type SqsSource<
  S extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  readonly schema: S;
  "~subscribe"(group: LambdaGroup, options?: SqsOptions): void;
};

export type SqsOptions = {
  /** The most messages the function receives in one invocation. */
  batchSize?: number;
  /** Seconds to wait to fill a batch before the function is invoked. */
  maxBatchingWindow?: number;
};

export type LambdaEvent = SqsEvent | ApiGatewayEvent | EventBridgeScheduleEvent;

/** The kind of a Lambda's event, or `none` for a Lambda declared without one. */
export type LambdaEventKind = LambdaEvent["kind"] | "none";

/**
 * The function receives SQS messages: from a queue that the declaration maps,
 * with `sqs.bind(queue)`, or from queues that infra maps to it, with
 * `sqs.schema(schema)`.
 */
export const sqs = {
  /**
   * The function receives the messages of `queue`. The infra build maps the
   * queue to the function, and `decode()` validates each message's JSON body
   * with the queue's schema. In the runtime build, a queue from an infra
   * module is replaced with its runtime options, as `{ schema }`.
   * @runtime queue
   */
  bind<S extends StandardSchemaV1 | undefined>(
    queue: SqsSource<S>,
    options?: SqsOptions,
  ): SqsEvent<S> {
    return { kind: "sqs", schema: queue?.schema, queue, options };
  },
  /**
   * The function receives SQS messages, from queues that infra maps to it
   * with `eventSourceMapping()`. `decode()` validates each message's JSON
   * body with `schema`. A queue that infra maps to the function must have no
   * schema, or this schema.
   */
  schema<S extends StandardSchemaV1>(schema: S): SqsEvent<S> {
    return { kind: "sqs", schema };
  },
};

/** The claims of a JWT, as API Gateway passes them to the function. */
export type JwtClaims =
  APIGatewayEventRequestContextJWTAuthorizer["jwt"]["claims"];

export type ApiGatewayKind = "apiGateway" | "apiGateway-jwt";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * The function receives API Gateway HTTP API requests. `decode()` validates
 * the body with `schema`, and the JWT claims with `claims`. A `schema` of
 * `null` means that the requests have no body. A request through a route
 * with a JWT authorizer has the kind `apiGateway-jwt`, because its event also
 * holds the token's claims.
 */
export type ApiGatewayEvent<
  S extends StandardSchemaV1 | null = StandardSchemaV1 | null,
  C extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  K extends ApiGatewayKind = ApiGatewayKind,
> = {
  kind: K;
  schema: S;
  claims: C;
  /**
   * The route that the infra build makes, from
   * `apiGateway.bind(api).defineRoute()`. It is not set for
   * `apiGateway.schema(body)`.
   */
  route?: ApiGatewayRoute;
};

/** A route that a declaration makes, on an API that infra declares. */
export type ApiGatewayRoute = {
  api: ApiSource;
  method: HttpMethod;
  path: `/${string}`;
  auth?: AuthorizerSource;
};

/**
 * An API that `apiGateway.bind()` routes to, from `api()`. In the function it
 * is `{}`, as the runtime build replaces the API with it.
 */
export type ApiSource = {
  "~route"(group: LambdaGroup, route: Omit<ApiGatewayRoute, "api">): void;
};

export type ApiGatewayRouteOptions<
  S extends StandardSchemaV1 | null,
  A extends AuthorizerSource | undefined,
> = {
  method: HttpMethod;
  path: `/${string}`;
  /**
   * Validates the body of a request in `decode()`, or `null` for a route
   * whose requests have no body. Import a schema from a shared module, so
   * the function can load it.
   */
  schema: S;
  /**
   * The route's authorizer, from `jwtAuthorizer()`. `decode()` validates the
   * JWT claims with its claims schema. In the runtime build, the authorizer
   * is replaced with its runtime options, as `{ claims }`.
   */
  auth?: A;
};

type ClaimsOf<A> = A extends AuthorizerSource<infer C> ? C : undefined;

/**
 * A JWT authorizer, from `jwtAuthorizer()`. In the function it holds only
 * the claims schema, as the runtime build replaces the authorizer with it.
 */
export type AuthorizerSource<
  C extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  readonly claims: C;
};

/**
 * The event of `apiGateway.schema(body)`, for routes with no authorizer.
 * `authSchema()` returns the event for routes with a JWT authorizer.
 */
export type ApiGatewaySchemaEvent<
  S extends StandardSchemaV1 | null = StandardSchemaV1 | null,
> = ApiGatewayEvent<S, undefined, "apiGateway"> & {
  /**
   * The function receives requests only through routes with a JWT
   * authorizer, and `decode()` returns the request's JWT claims. With
   * `claims`, `decode()` validates the claims with it, and the authorizer
   * must have the same claims schema, or none. Without `claims`, any
   * authorizer is accepted.
   */
  authSchema<C extends StandardSchemaV1 | undefined = undefined>(
    claims?: C,
  ): ApiGatewayEvent<S, C, "apiGateway-jwt">;
};

/**
 * The function receives API Gateway HTTP API requests: from a route that the
 * declaration makes, with `apiGateway.bind(api).defineRoute(options)`, or
 * from routes that infra makes with `router()`, with
 * `apiGateway.schema(body)` or `apiGateway.schema(body).authSchema(claims)`.
 * `body` is a schema, or `null` for requests with no body.
 */
export const apiGateway = {
  /**
   * Binds the function to `api`, an API that infra declares. Call
   * `defineRoute()` on the result. In the runtime build, an API from an infra
   * module is replaced with `{}`.
   * @runtime api
   */
  bind(api: ApiSource) {
    return {
      /**
       * The function receives the requests of a route on the API, which the
       * infra build makes. `decode()` validates the body with `schema`, and
       * the JWT claims with the claims schema of `auth`. With `schema: null`,
       * `decode()` rejects a request with a body. With `auth`, the event has
       * the kind `apiGateway-jwt`.
       * @runtime options.auth
       */
      defineRoute<
        S extends StandardSchemaV1 | null,
        A extends AuthorizerSource | undefined = undefined,
      >(
        options: ApiGatewayRouteOptions<S, A>,
      ): ApiGatewayEvent<
        S,
        ClaimsOf<A>,
        A extends AuthorizerSource ? "apiGateway-jwt" : "apiGateway"
      > {
        const { method, path, schema, auth } = options;
        return {
          kind: (auth ? "apiGateway-jwt" : "apiGateway") as any,
          schema,
          claims: auth?.claims as ClaimsOf<A>,
          route: { api, method, path, auth },
        };
      },
    };
  },
  /**
   * The function receives requests from routes that infra makes, with no
   * authorizer. `decode()` validates the body with `body`. With `null`,
   * `decode()` rejects a request with a body. Call `authSchema()` on the
   * result for routes with a JWT authorizer.
   */
  schema<S extends StandardSchemaV1 | null>(body: S): ApiGatewaySchemaEvent<S> {
    const event = { kind: "apiGateway", schema: body, claims: undefined };
    // `authSchema` is not enumerable, so it is not part of the event's data,
    // which `decode()` and the infra checks read.
    return Object.defineProperty(event, "authSchema", {
      value: <C extends StandardSchemaV1 | undefined>(claims?: C) => ({
        kind: "apiGateway-jwt" as const,
        schema: body,
        claims: claims as C,
      }),
    }) as ApiGatewaySchemaEvent<S>;
  },
};

/** The function receives EventBridge scheduled events. */
export type EventBridgeScheduleEvent = {
  kind: "eventBridge";
  /**
   * The schedule that the infra build makes, from
   * `eventBridge.defineSchedule()`. It is not set for
   * `eventBridge.schema(null)`, nor in the runtime build.
   */
  schedule?: ScheduleOptions;
};

export type ScheduleOptions = {
  /**
   * Keys the rule in state. Changing the id replaces the rule, so keep it
   * stable. Must be name-safe: 1 to 64 letters, digits, hyphens or
   * underscores.
   */
  id: string;
  /**
   * The rule's name in AWS, in place of the id. The rule is named
   * `<app>--<stage>--<name>`. Changing the name replaces the rule. Must be
   * name-safe.
   */
  name?: string;
  /** When the rule invokes the function, such as `rate(1, "day")`. */
  schedule: Schedule;
};

/**
 * The function receives EventBridge scheduled events: from a schedule that
 * the declaration makes, with `eventBridge.defineSchedule(options)`, or from
 * schedules that infra makes with `schedule()`, with
 * `eventBridge.schema(null)`.
 */
export const eventBridge = {
  /**
   * The function receives the events of a schedule, whose rule the infra
   * build makes. The function doesn't read the options, so the runtime build
   * removes them. `id` must be a name-safe string literal; see `NameSafe`.
   * @runtime
   */
  defineSchedule<const Id extends string>(
    options: Omit<ScheduleOptions, "id"> & { id: NameSafe<Id> },
  ): EventBridgeScheduleEvent {
    return { kind: "eventBridge", schedule: options };
  },
  /**
   * The function receives the events of schedules that infra makes. A
   * scheduled event has no detail to validate, so `detail` must be `null`.
   */
  schema(detail: null): EventBridgeScheduleEvent {
    return { kind: "eventBridge" };
  },
};

type KindOf<E> = E extends { kind: infer K } ? K : "none";

type Decoded<S> = S extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<S>
  : unknown;

// The body of a request as `decode()` returns it: the output of the body
// schema, or `undefined` for a body schema of `null`.
type DecodedRequestBody<S> = S extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<S>
  : undefined;

// `T` with the fields of `U` in place of its own.
type Replace<T, U> = Omit<T, keyof U> & U;

type JwtRequest = {
  requestContext: { authorizer: { jwt: { claims: unknown } } };
};

// A request through a route with a JWT authorizer must hold the JWT claims.
type ApiGatewayRequest<K> = Pick<
  APIGatewayProxyEventV2,
  "body" | "isBase64Encoded"
> &
  ([K] extends ["apiGateway-jwt"] ? JwtRequest : {});

// The claims of a request through a JWT authorizer, as `decode()` returns
// them: the output of the claims schema, or the claims as API Gateway sends
// them when there is no schema. A request with no authorizer has no claims.
type DecodedClaims<C, K> = [K] extends ["apiGateway-jwt"]
  ? {
      claims: C extends StandardSchemaV1
        ? StandardSchemaV1.InferOutput<C>
        : JwtClaims;
    }
  : {};

type DecodeFor<E> =
  E extends SqsEvent<infer S>
    ? <R extends SQSRecord>(
        record: R,
      ) => Promise<Replace<R, { body: Decoded<S> }>>
    : E extends ApiGatewayEvent<infer S, infer C, infer K>
      ? <R extends ApiGatewayRequest<K>>(
          event: R,
        ) => Promise<
          Replace<R, { body: DecodedRequestBody<S> } & DecodedClaims<C, K>>
        >
      : never;

/**
 * A Lambda function, as `$lambda` declares it. Infra wires it, and the
 * function's code uses its types and its runtime API.
 */
export interface Lambda<
  E extends LambdaEvent | undefined = LambdaEvent | undefined,
  Env extends EnvVars = EnvVars,
> {
  readonly id: string;
  /**
   * Carries the event and the bound variables for the type helpers. It is
   * never set, so it is optional.
   */
  readonly "~lambda"?: { kind: KindOf<E>; event: E; env: Env };
  /**
   * The variables that the declaration binds, read from the function's
   * environment. Throws when one of them is not set.
   */
  env(): Readonly<Env>;
  /**
   * Decodes one item that the function received, and returns the item with
   * its decoded parts in place of the raw ones. For SQS the item is a record,
   * and `body` is the JSON body, validated with the event's schema. For API
   * Gateway the item is the request, and a base64 body is decoded first.
   * `body` is the JSON body, validated with the body schema. When the body is
   * not JSON, or the schema rejects the parsed value, the body is validated
   * as a string, so a route takes text with a string schema. An empty body
   * is validated as `undefined`. With a body schema of `null`, `body` is
   * `undefined`, and a request with a body is not valid. A request through a
   * JWT authorizer also
   * gets `claims`: the JWT claims, validated with the event's claims schema
   * if it has one. Throws a `DecodeError` when the item is not valid.
   */
  decode: DecodeFor<E>;
}

export type EnvVars = Record<string, string>;

type HttpHandler<Event> = (
  event: Event,
  context: Context,
) => ApiGatewayResult | Promise<ApiGatewayResult>;

type HandlerFor<E> = E extends SqsEvent
  ? (
      event: SQSEvent,
      context: Context,
    ) => SQSBatchResponse | void | Promise<SQSBatchResponse | void>
  : E extends ApiGatewayEvent<any, any, "apiGateway-jwt">
    ? HttpHandler<APIGatewayJWTProxyEventV2<JwtClaims>>
    : E extends ApiGatewayEvent<any, any, "apiGateway">
      ? HttpHandler<APIGatewayProxyEventV2>
      : E extends EventBridgeScheduleEvent
        ? (
            event: EventBridgeEvent<"Scheduled Event", unknown>,
            context: Context,
          ) => void | Promise<void>
        : (event: unknown, context: Context) => unknown;

/**
 * The type of the `handler` export of a Lambda's module, from the
 * declaration: `export const handler: LambdaHandler<typeof lambda> = ...`.
 */
export type LambdaHandler<
  L extends { readonly "~lambda"?: { event: LambdaEvent | undefined } },
> = HandlerFor<NonNullable<L["~lambda"]>["event"]>;

/** The variables that a Lambda's declaration binds. */
export type LambdaEnv<L extends { readonly "~lambda"?: { env: EnvVars } }> =
  Readonly<NonNullable<L["~lambda"]>["env"]>;

/** Thrown by `decode()` when an item is not valid. */
export class DecodeError extends Error {
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>;

  constructor(
    message: string,
    issues: ReadonlyArray<StandardSchemaV1.Issue> = [],
  ) {
    super(message);
    this.name = "DecodeError";
    this.issues = issues;
  }
}

/** The options of a declaration that its runtime API reads. */
export type RuntimeOptions = {
  id?: string;
  event?: () => LambdaEvent | undefined;
  env?: () => Record<string, unknown>;
};

/**
 * Makes `decode()` from the declaration's `event` option. The option is read
 * on the first call, so a declaration in an import cycle can be made before
 * the modules that its event refers to have loaded.
 */
export function createDecode(
  options: RuntimeOptions,
): (item: any) => Promise<unknown> {
  let event: LambdaEvent | undefined;
  return async (item) => {
    event ??= options.event?.();
    if (!event || event.kind === "eventBridge") {
      throw new Error(
        `decode() needs a Lambda declared with event: () => sqs.bind(queue), sqs.schema(schema), apiGateway.bind(api).defineRoute(options) or apiGateway.schema(body).`,
      );
    }
    if (event.kind === "sqs") {
      return {
        ...item,
        body: await decodeBody(event.schema, item?.body, "message"),
      };
    }
    const claims =
      event.kind === "apiGateway-jwt"
        ? { claims: await decodeClaims(event.claims, item) }
        : {};
    const raw: string | undefined =
      item?.isBase64Encoded && item.body !== undefined
        ? Buffer.from(item.body, "base64").toString("utf8")
        : item?.body;
    // A body schema of `null` means the requests have no body.
    if (!event.schema) {
      if (raw) {
        throw new DecodeError(
          "The request has a body, but the function's body schema is null, so its requests must have no body.",
        );
      }
      return { ...item, body: undefined, ...claims };
    }
    // A request with no body, such as a GET, has nothing to parse, and the
    // schema decides whether that is valid.
    const body = raw
      ? await decodeRequestBody(event.schema, raw)
      : await validateBody(event.schema, undefined, "request");
    return { ...item, body, ...claims };
  };
}

async function decodeBody(
  schema: StandardSchemaV1 | undefined,
  body: string,
  name: "message",
): Promise<unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new DecodeError(`The ${name} body is not valid JSON.`);
  }
  if (!schema) return value;
  return validateBody(schema, value, name);
}

// Validates the JSON body. When the body is not JSON, or the schema rejects
// the parsed value, the body is validated as a string, so a string schema
// accepts text such as `hello` or `123`. When both fail, the error is the one
// for the JSON body.
async function decodeRequestBody(
  schema: StandardSchemaV1,
  raw: string,
): Promise<unknown> {
  let parsed: { value: unknown } | undefined;
  try {
    parsed = { value: JSON.parse(raw) };
  } catch {}
  const text = () => schema["~standard"].validate(raw);
  if (!parsed) {
    const result = await text();
    if (!result.issues) return result.value;
    throw new DecodeError("The request body is not valid JSON.");
  }
  const result = await schema["~standard"].validate(parsed.value);
  if (!result.issues) return result.value;
  const asText = await text();
  if (!asText.issues) return asText.value;
  throw new DecodeError(
    `The request body is not valid: ${details(result.issues)}`,
    result.issues,
  );
}

async function validateBody(
  schema: StandardSchemaV1,
  value: unknown,
  name: "message" | "request",
): Promise<unknown> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    throw new DecodeError(
      `The ${name} body is not valid: ${details(result.issues)}`,
      result.issues,
    );
  }
  return result.value;
}

// Returns the claims as the request holds them when there is no schema.
async function decodeClaims(
  schema: StandardSchemaV1 | undefined,
  request: any,
): Promise<unknown> {
  const claims = request?.requestContext?.authorizer?.jwt?.claims;
  if (claims === undefined) {
    throw new DecodeError(
      "The request has no JWT claims. Route it through a route with a JWT authorizer.",
    );
  }
  if (!schema) return claims;
  const result = await schema["~standard"].validate(claims);
  if (result.issues) {
    throw new DecodeError(
      `The request's JWT claims are not valid: ${details(result.issues)}`,
      result.issues,
    );
  }
  return result.value;
}

const details = (issues: ReadonlyArray<StandardSchemaV1.Issue>) =>
  issues.map((issue) => issue.message).join("; ");

/**
 * Makes `env()` for the function. The runtime build keeps the names of the
 * `env` option and removes the values, so the names are read from the
 * option, and the values from `process.env`.
 */
export function createRuntimeEnv(options: RuntimeOptions): () => EnvVars {
  let values: EnvVars | undefined;
  return () => {
    if (values) return values;
    const read: EnvVars = {};
    for (const name of Object.keys(options.env?.() ?? {})) {
      const value = process.env[name];
      if (value === undefined) {
        throw new Error(
          `The environment variable ${name} is not set. Deploy sets the variables that the Lambda's declaration binds in env.`,
        );
      }
      read[name] = value;
    }
    values = read;
    return values;
  };
}
