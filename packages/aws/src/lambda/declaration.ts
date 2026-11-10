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
import type { EventPattern } from "src/event-bridge/pattern";
import type { LambdaGroup } from "./lambda";
import type { NameSafe } from "src/id";
import type { APIGatewayJWTProxyEventV2, ApiGatewayResult } from "./handler";

// This module is part of both builds. In the runtime build it must not import
// infra code, so it imports only types.

/**
 * The function receives SQS messages, which `decode()` validates with
 * `schema`. `F` is the type of `reportBatchItemFailures`, which sets what the
 * handler can return.
 */
export type SqsEvent<
  S extends StandardSchemaV1 = StandardSchemaV1,
  F extends boolean = boolean,
> = {
  kind: "sqs";
  schema: S;
  /**
   * The queue that the infra build maps to the function, from `sqs.bind()`.
   * It is not set for `sqs.schema()`.
   */
  queue?: SqsSource<S>;
  options?: Omit<SqsOptions, "reportBatchItemFailures"> & {
    reportBatchItemFailures?: F;
  };
};

/**
 * A queue that `sqs.bind()` reads, from `queue()`. In the function it holds only
 * the queue's schema, as the runtime build replaces the queue with it.
 */
export type SqsSource<S extends StandardSchemaV1 = StandardSchemaV1> = {
  readonly schema: S;
  "~subscribe"(group: LambdaGroup, options?: SqsOptions): void;
};

export type SqsOptions = {
  /** The most messages the function receives in one invocation. */
  batchSize?: number;
  /** Seconds to wait to fill a batch before the function is invoked. */
  maximumBatchingWindow?: number;
  /**
   * Lets the handler return `{ batchItemFailures }`, the messages that
   * failed, so that Lambda deletes the others and only the failed messages
   * return to the queue. Without it, Lambda ignores the result, and a batch
   * succeeds or fails as a whole.
   */
  reportBatchItemFailures?: boolean;
  /**
   * The most instances of the function that the mapping invokes at once,
   * from 2 to 1,000.
   */
  maximumConcurrency?: number;
  /** `false` pauses the mapping, so Lambda stops reading the queue. */
  enabled?: boolean;
};

export type LambdaEvent = SqsEvent | ApiGatewayEvent | EventBridgeRuleEvent;

/** The kind of a Lambda's event, or `none` for a Lambda declared without one. */
export type LambdaEventKind = LambdaEvent["kind"] | "none";

// The overloads type the handler's result from reportBatchItemFailures: `true`,
// `false` or left out, or a `boolean`.
function bindSqs<S extends StandardSchemaV1>(
  queue: SqsSource<S>,
  options: SqsOptions & { reportBatchItemFailures: true },
): SqsEvent<S, true>;
function bindSqs<S extends StandardSchemaV1>(
  queue: SqsSource<S>,
  options?: Omit<SqsOptions, "reportBatchItemFailures"> & {
    reportBatchItemFailures?: false;
  },
): SqsEvent<S, false>;
function bindSqs<S extends StandardSchemaV1>(
  queue: SqsSource<S>,
  options: SqsOptions,
): SqsEvent<S>;
function bindSqs<S extends StandardSchemaV1>(
  queue: SqsSource<S>,
  options?: SqsOptions,
): SqsEvent<S> {
  return { kind: "sqs", schema: queue.schema, queue, options };
}

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
   */
  bind: bindSqs,
  /**
   * The function receives SQS messages, from queues that infra maps to it
   * with `eventSourceMapping()`. `decode()` validates each message's JSON
   * body with `schema`. A queue that infra maps to the function must have
   * this schema.
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
   */
  bind(api: ApiSource) {
    return {
      /**
       * The function receives the requests of a route on the API, which the
       * infra build makes. `decode()` validates the body with `schema`, and
       * the JWT claims with the claims schema of `auth`. With `schema: null`,
       * `decode()` rejects a request with a body. With `auth`, the event has
       * the kind `apiGateway-jwt`. In the runtime build, an authorizer from
       * an infra module is replaced with `{ claims }`.
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
    return {
      kind: "apiGateway",
      schema: body,
      claims: undefined,
      authSchema: <C extends StandardSchemaV1 | undefined>(claims?: C) => ({
        kind: "apiGateway-jwt" as const,
        schema: body,
        claims: claims as C,
      }),
    };
  },
};

/**
 * The function receives the events of EventBridge rules. A `schema` of
 * `null` means scheduled events, which have no detail. Otherwise `decode()`
 * validates each event's detail with `schema`.
 */
export type EventBridgeRuleEvent<
  S extends StandardSchemaV1 | null = StandardSchemaV1 | null,
> = {
  kind: "eventBridge";
  schema: S;
  /**
   * The schedule that the infra build makes, from
   * `eventBridge.defineSchedule()`.
   */
  schedule?: ScheduleOptions;
  /**
   * The rule that the infra build makes, from
   * `eventBridge.bind(bus).defineRule()`.
   */
  rule?: EventBridgeRule;
};

/** The event of `eventBridge.defineSchedule()` and `eventBridge.schema(null)`. */
export type EventBridgeScheduleEvent = EventBridgeRuleEvent<null>;

/** A rule that a declaration makes, on a bus that infra declares. */
export type EventBridgeRule = {
  bus: EventBusSource;
  options: RuleOptions;
};

/**
 * An event bus that `eventBridge.bind()` makes rules on, from `eventBus()` or
 * `defaultEventBus()`. In the function it is `{}`, as the runtime build
 * replaces the bus with it.
 */
export type EventBusSource = {
  "~rule"(group: LambdaGroup, options: RuleOptions): void;
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

export type RuleOptions = {
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
  /**
   * The events that the rule sends to the function, such as
   * `{ source: ["shop"], "detail-type": ["OrderPlaced"] }`.
   */
  pattern: EventPattern;
  /** `false` disables the rule, so it sends no events. Defaults to `true`. */
  enabled?: boolean;
  /** How EventBridge retries an event that the function fails to receive. */
  retry?: RetryOptions;
};

export type RetryOptions = {
  /** Times to retry an event, from 0 to 185. EventBridge's default is 185. */
  maxAttempts?: number;
  /**
   * Seconds to keep retrying an event, from 60 to 86,400. EventBridge's
   * default is 86,400 (24 hours).
   */
  maxEventAge?: number;
};

/**
 * The function receives EventBridge events: from a rule or a schedule that
 * the declaration makes, with `eventBridge.bind(bus).defineRule(options)` or
 * `eventBridge.defineSchedule(options)`, or from rules and schedules that
 * infra makes, with `eventBridge.schema(detail)`.
 */
export const eventBridge = {
  /**
   * Binds the function to `bus`, an event bus that infra declares. Call
   * `defineRule()` on the result. In the runtime build, a bus from an infra
   * module is replaced with `{}`.
   */
  bind(bus: EventBusSource) {
    return {
      /**
       * The function receives the events that match `pattern` on the bus.
       * The infra build makes the rule, and `decode()` validates each
       * event's detail with `schema`. `id` must be a name-safe string
       * literal; see `NameSafe`.
       */
      defineRule<S extends StandardSchemaV1, const Id extends string>(
        options: Omit<RuleOptions, "id"> & {
          id: NameSafe<Id>;
          /**
           * Validates the detail of each event, in `decode()`. A rule that
           * matches any detail declares a schema such as `v.unknown()`.
           * Import it from a shared module, so the function can load it.
           */
          schema: S;
        },
      ): EventBridgeRuleEvent<S> {
        const { schema, ...rule } = options;
        return { kind: "eventBridge", schema, rule: { bus, options: rule } };
      },
    };
  },
  /**
   * The function receives the events of a schedule, whose rule the infra
   * build makes. `id` must be a name-safe string literal; see `NameSafe`.
   */
  defineSchedule<const Id extends string>(
    options: Omit<ScheduleOptions, "id"> & { id: NameSafe<Id> },
  ): EventBridgeScheduleEvent {
    return { kind: "eventBridge", schema: null, schedule: options };
  },
  /**
   * The function receives the events of rules that infra makes with
   * `rule()`, and `decode()` validates each event's detail with `detail`. For
   * schedules that infra makes with `schedule()`, `detail` is `null`, as a
   * scheduled event has no detail.
   */
  schema<S extends StandardSchemaV1 | null>(
    detail: S,
  ): EventBridgeRuleEvent<S> {
    return { kind: "eventBridge", schema: detail };
  },
};

type KindOf<E> = E extends { kind: infer K } ? K : "none";

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
      ) => Promise<Replace<R, { body: StandardSchemaV1.InferOutput<S> }>>
    : E extends ApiGatewayEvent<infer S, infer C, infer K>
      ? <R extends ApiGatewayRequest<K>>(
          event: R,
        ) => Promise<
          Replace<R, { body: DecodedRequestBody<S> } & DecodedClaims<C, K>>
        >
      : E extends EventBridgeRuleEvent<infer S>
        ? S extends StandardSchemaV1
          ? <R extends { detail: unknown }>(
              event: R,
            ) => Promise<
              Replace<R, { detail: StandardSchemaV1.InferOutput<S> }>
            >
          : never
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
   * `body` is the JSON body, validated with the body schema. An empty body
   * is validated as `undefined`. With a body schema of `null`, `body` is
   * `undefined`, and a request with a body is not valid. A request through a
   * JWT authorizer also gets `claims`: the JWT claims, validated with the
   * event's claims schema if it has one. For EventBridge the item is the
   * event, and `detail` is validated with the event's schema. Throws a
   * `DecodeError` when the item is not valid.
   */
  decode: DecodeFor<E>;
}

export type EnvVars = Record<string, string>;

type HttpHandler<Event> = (
  event: Event,
  context: Context,
) => ApiGatewayResult | Promise<ApiGatewayResult>;

// A handler can return `{ batchItemFailures }` only when the mapping sets
// reportBatchItemFailures. Without it, Lambda ignores the result and deletes
// the failed messages. `undefined` is in the union so that a handler that
// returns an object does not match it as it would match a bare `void`.
type SqsResult<F> = [F] extends [false]
  ? void | undefined
  : SQSBatchResponse | void;

type HandlerFor<E> =
  E extends SqsEvent<any, infer F>
    ? (
        event: SQSEvent,
        context: Context,
      ) => SqsResult<F> | Promise<SqsResult<F>>
    : E extends ApiGatewayEvent<any, any, "apiGateway-jwt">
      ? HttpHandler<APIGatewayJWTProxyEventV2<JwtClaims>>
      : E extends ApiGatewayEvent<any, any, "apiGateway">
        ? HttpHandler<APIGatewayProxyEventV2>
        : E extends EventBridgeRuleEvent<infer S>
          ? (
              event: [S] extends [null]
                ? EventBridgeEvent<"Scheduled Event", unknown>
                : EventBridgeEvent<string, unknown>,
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
  /**
   * The part of the item that is not valid: the body of a message or a
   * request, the JWT claims of a request, or the detail of an EventBridge
   * event.
   */
  readonly part: "body" | "claims" | "detail";
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>;

  constructor(
    message: string,
    part: "body" | "claims" | "detail",
    issues: ReadonlyArray<StandardSchemaV1.Issue> = [],
  ) {
    super(message);
    this.name = "DecodeError";
    this.part = part;
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
    if (event?.kind === "eventBridge" && event.schema) {
      return {
        ...item,
        detail: await validate(
          event.schema,
          item?.detail,
          "detail",
          "event detail is",
        ),
      };
    }
    if (!event || event.kind === "eventBridge") {
      throw new Error(
        `decode() needs a Lambda declared with event: () => sqs.bind(queue), sqs.schema(schema), apiGateway.bind(api).defineRoute(options), apiGateway.schema(body), eventBridge.bind(bus).defineRule(options) or eventBridge.schema(schema). A scheduled event has no detail to decode.`,
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
          "body",
        );
      }
      return { ...item, body: undefined, ...claims };
    }
    // A request with no body, such as a GET, has nothing to parse, and the
    // schema decides whether that is valid.
    const body = raw
      ? await decodeBody(event.schema, raw, "request")
      : await validate(event.schema, undefined, "body", "request body is");
    return { ...item, body, ...claims };
  };
}

async function decodeBody(
  schema: StandardSchemaV1,
  body: string,
  name: "message" | "request",
): Promise<unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new DecodeError(`The ${name} body is not valid JSON.`, "body");
  }
  return validate(schema, value, "body", `${name} body is`);
}

async function validate(
  schema: StandardSchemaV1,
  value: unknown,
  part: DecodeError["part"],
  // Names the value at the start of the error, such as "request body is".
  subject: string,
): Promise<unknown> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    const issues = result.issues.map((issue) => issue.message).join("; ");
    throw new DecodeError(
      `The ${subject} not valid: ${issues}`,
      part,
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
      "claims",
    );
  }
  if (!schema) return claims;
  return validate(schema, claims, "claims", "request's JWT claims are");
}

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
