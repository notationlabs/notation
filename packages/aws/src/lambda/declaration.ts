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
import type { LambdaGroup } from "./lambda";
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

/**
 * The function receives requests through a route with a JWT authorizer.
 * `Claims` types the token's claims in the event. It is not checked against
 * the tokens.
 */
export type JwtAuth<Claims = JwtClaims> = {
  type: "jwt";
  /** Carries the claims type. It is never set. */
  readonly "~claims"?: Claims;
};

type JwtClaims = APIGatewayEventRequestContextJWTAuthorizer["jwt"]["claims"];

export type HttpAuth = JwtAuth<any>;

/**
 * The function receives HTTP API requests, whose JSON body `decode()`
 * validates with `schema`. A request through a route with a JWT authorizer
 * has the kind `http-jwt`, because its event also holds the token's claims.
 */
export type HttpEvent<
  S extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  A extends HttpAuth | undefined = HttpAuth | undefined,
> = {
  kind: A extends HttpAuth ? "http-jwt" : "http";
  schema: S;
  auth: A;
};

export type HttpOptions<
  S extends StandardSchemaV1 | undefined,
  A extends HttpAuth | undefined,
> = {
  /** Validates the JSON body of a request in `decode()`. */
  body?: S;
  /**
   * The route's authorizer, such as `jwt<Claims>()`. Infra can only wire the
   * function to routes with this authorizer.
   */
  auth?: A;
};

/** The function receives EventBridge scheduled events. */
export type ScheduledEvent = { kind: "scheduled" };

export type LambdaEvent = SqsEvent | HttpEvent | ScheduledEvent;

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

/**
 * The function receives HTTP API requests, from routes on an API.
 * @runtime options
 */
export function http<
  S extends StandardSchemaV1 | undefined = undefined,
  A extends HttpAuth | undefined = undefined,
>(options: HttpOptions<S, A> = {}): HttpEvent<S, A> {
  return {
    kind: (options.auth ? "http-jwt" : "http") as HttpEvent<S, A>["kind"],
    schema: options.body as S,
    auth: options.auth as A,
  };
}

/**
 * The function's routes have a JWT authorizer. `Claims` types the token's
 * claims in the handler's event.
 */
export function jwt<Claims = JwtClaims>(): JwtAuth<Claims> {
  return { type: "jwt" };
}

/** The function receives EventBridge scheduled events, from a schedule. */
export function scheduled(): ScheduledEvent {
  return { kind: "scheduled" };
}

type KindOf<E> = E extends { kind: infer K } ? K : "none";

type Decoded<S> = S extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<S>
  : unknown;

type DecodeFor<E> =
  E extends SqsEvent<infer S>
    ? (record: SQSRecord) => Promise<Decoded<S>>
    : E extends HttpEvent<infer S, any>
      ? (
          event: Pick<APIGatewayProxyEventV2, "body" | "isBase64Encoded">,
        ) => Promise<Decoded<S>>
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
   * Parses one item that the function received as JSON, and validates it
   * with the event's schema. For SQS the item is a record, and for HTTP it
   * is the request. Throws a `DecodeError` when the item is not valid.
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
  : E extends HttpEvent<any, JwtAuth<infer Claims>>
    ? HttpHandler<APIGatewayJWTProxyEventV2<Claims>>
    : E extends HttpEvent
      ? HttpHandler<APIGatewayProxyEventV2>
      : E extends ScheduledEvent
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
    if (!event || event.kind === "scheduled") {
      throw new Error(
        `decode() needs a Lambda declared with event: () => sqs.bind(queue), event: () => sqs.schema(schema) or event: () => http({ body: schema }).`,
      );
    }
    const body =
      event.kind !== "sqs" && item?.isBase64Encoded
        ? Buffer.from(item.body ?? "", "base64").toString("utf8")
        : item?.body;
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new DecodeError(
        `The ${event.kind === "sqs" ? "message" : "request"} body is not valid JSON.`,
      );
    }
    if (!event.schema) return value;
    const result = await event.schema["~standard"].validate(value);
    if (result.issues) {
      const details = result.issues.map((issue) => issue.message).join("; ");
      throw new DecodeError(
        `The ${event.kind === "sqs" ? "message" : "request"} body is not valid: ${details}`,
        result.issues,
      );
    }
    return result.value;
  };
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
