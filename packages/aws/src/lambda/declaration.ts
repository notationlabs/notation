import type { StandardSchemaV1 } from "@notation/resource";
import type {
  APIGatewayProxyEventV2,
  Context,
  EventBridgeEvent,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
} from "aws-lambda";
import type { ApiGatewayResult } from "src/shared/lambda.handler";

// This module is part of both builds. In the runtime build it must not import
// infra code, so it imports only types.

/** The function receives SQS messages, which `decode()` validates with `schema`. */
export type SqsEvent<
  S extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  kind: "sqs";
  schema: S;
};

/** The function receives HTTP API requests, whose JSON body `decode()` validates with `schema`. */
export type HttpEvent<
  S extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  kind: "http";
  schema: S;
};

/** The function receives EventBridge scheduled events. */
export type ScheduledEvent = { kind: "scheduled" };

export type LambdaEvent = SqsEvent | HttpEvent | ScheduledEvent;

/** The kind of a Lambda's event, or `none` for a Lambda declared without one. */
export type LambdaEventKind = LambdaEvent["kind"] | "none";

/**
 * The function receives SQS messages.
 * @param schema Validates the JSON body of each message in `decode()`.
 * @runtime schema
 */
export function sqs<S extends StandardSchemaV1 | undefined = undefined>(
  schema?: S,
): SqsEvent<S> {
  return { kind: "sqs", schema: schema as S };
}

/**
 * The function receives HTTP API requests, from routes on an API.
 * @param schema Validates the JSON body of a request in `decode()`.
 * @runtime schema
 */
export function http<S extends StandardSchemaV1 | undefined = undefined>(
  schema?: S,
): HttpEvent<S> {
  return { kind: "http", schema: schema as S };
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
    : E extends HttpEvent<infer S>
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

type HandlerFor = {
  sqs: (
    event: SQSEvent,
    context: Context,
  ) => SQSBatchResponse | void | Promise<SQSBatchResponse | void>;
  http: (
    event: APIGatewayProxyEventV2,
    context: Context,
  ) => ApiGatewayResult | Promise<ApiGatewayResult>;
  scheduled: (
    event: EventBridgeEvent<"Scheduled Event", unknown>,
    context: Context,
  ) => void | Promise<void>;
  none: (event: unknown, context: Context) => unknown;
};

/**
 * The type of the `handler` export of a Lambda's module, from the
 * declaration: `export const handler: LambdaHandler<typeof lambda> = ...`.
 */
export type LambdaHandler<
  L extends { readonly "~lambda"?: { kind: LambdaEventKind } },
> = HandlerFor[NonNullable<L["~lambda"]>["kind"]];

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
    if (event?.kind !== "sqs" && event?.kind !== "http") {
      throw new Error(
        `decode() needs a Lambda declared with event: () => sqs(schema) or event: () => http(schema).`,
      );
    }
    const body =
      event.kind === "http" && item?.isBase64Encoded
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
