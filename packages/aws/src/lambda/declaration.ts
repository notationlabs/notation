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
 * the JSON body with `schema`, and the JWT claims with `claims`. A request
 * through a route with a JWT authorizer has the kind `apiGateway-jwt`,
 * because its event also holds the token's claims.
 */
export type ApiGatewayEvent<
  S extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  C extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  K extends ApiGatewayKind = ApiGatewayKind,
> = {
  kind: K;
  schema: S;
  claims: C;
};

/**
 * A JWT authorizer, from `jwtAuthorizer()`. In the function it holds only
 * the claims schema, as the runtime build replaces the authorizer with it.
 */
export type AuthorizerSource<
  C extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  readonly claims: C;
};

export type ApiGatewaySchemaOptions<C extends StandardSchemaV1 | undefined> = {
  /**
   * Validates the JWT claims of a request in `decode()`. A declaration with
   * claims receives requests only through routes with a JWT authorizer, whose
   * claims schema must be this schema.
   */
  claims?: C;
};

type ApiGatewayKindOf<C> = [C] extends [StandardSchemaV1]
  ? "apiGateway-jwt"
  : "apiGateway";

/**
 * The function receives API Gateway HTTP API requests, from routes that
 * infra makes with `router()`.
 */
export const apiGateway = {
  /**
   * The function receives requests from routes that infra makes. `decode()`
   * validates the JSON body with `body`, and the JWT claims with
   * `options.claims`. With claims, the function receives requests only
   * through routes with a JWT authorizer whose claims schema is the same
   * schema. Without claims, it receives requests only through routes with no
   * authorizer.
   */
  schema<
    S extends StandardSchemaV1 | undefined = undefined,
    C extends StandardSchemaV1 | undefined = undefined,
  >(
    body?: S,
    options?: ApiGatewaySchemaOptions<C>,
  ): ApiGatewayEvent<S, C, ApiGatewayKindOf<C>> {
    return {
      kind: (options?.claims
        ? "apiGateway-jwt"
        : "apiGateway") as ApiGatewayKindOf<C>,
      schema: body as S,
      claims: options?.claims as C,
    };
  },
};

/** The function receives EventBridge scheduled events. */
export type EventBridgeScheduleEvent = { kind: "eventBridge" };

/** The function receives EventBridge scheduled events. */
export const eventBridge = {
  /** The function receives the events of schedules that infra makes. */
  schedule(): EventBridgeScheduleEvent {
    return { kind: "eventBridge" };
  },
};

type KindOf<E> = E extends { kind: infer K } ? K : "none";

type Decoded<S> = S extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<S>
  : unknown;

// A request to a function with a claims schema must hold the JWT claims.
type ApiGatewayRequest<C> = Pick<
  APIGatewayProxyEventV2,
  "body" | "isBase64Encoded"
> &
  ([C] extends [StandardSchemaV1]
    ? { requestContext: { authorizer: { jwt: { claims: unknown } } } }
    : {});

type DecodeFor<E> =
  E extends SqsEvent<infer S>
    ? (record: SQSRecord) => Promise<Decoded<S>>
    : E extends ApiGatewayEvent<infer S, infer C, any>
      ? (event: ApiGatewayRequest<C>) => Promise<Decoded<S>>
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
   * with the event's schema. For SQS the item is a record, and for API
   * Gateway it is the request. For a request, `decode()` also validates the
   * JWT claims with the event's claims schema, if it has one, but returns
   * only the body. Throws a `DecodeError` when the item is not valid.
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
    const isSqs = event.kind === "sqs";
    const name = isSqs ? "message" : "request";
    if (event.kind !== "sqs" && event.claims) {
      await validateClaims(event.claims, item);
    }
    const body =
      !isSqs && item?.isBase64Encoded
        ? Buffer.from(item.body ?? "", "base64").toString("utf8")
        : item?.body;
    // A request with no body, such as a GET, has nothing to parse.
    if (!isSqs && !event.schema && (body === undefined || body === "")) {
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new DecodeError(`The ${name} body is not valid JSON.`);
    }
    if (!event.schema) return value;
    const result = await event.schema["~standard"].validate(value);
    if (result.issues) {
      throw new DecodeError(
        `The ${name} body is not valid: ${details(result.issues)}`,
        result.issues,
      );
    }
    return result.value;
  };
}

async function validateClaims(
  schema: StandardSchemaV1,
  request: any,
): Promise<void> {
  const claims = request?.requestContext?.authorizer?.jwt?.claims;
  if (claims === undefined) {
    throw new DecodeError(
      "The request has no JWT claims. Route it through a route with a JWT authorizer.",
    );
  }
  const result = await schema["~standard"].validate(claims);
  if (result.issues) {
    throw new DecodeError(
      `The request's JWT claims are not valid: ${details(result.issues)}`,
      result.issues,
    );
  }
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
