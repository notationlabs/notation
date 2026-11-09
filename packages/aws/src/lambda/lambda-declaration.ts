import * as aws from "@notation/aws.iac";
import { filePaths, fromProjectRoot, toProjectRoot } from "@notation/core";
import {
  getActiveResourceCollection,
  getDeclaredIn,
  onEvaluationEnd,
} from "@notation/resource";
import {
  createDecode,
  type EnvVars,
  type Lambda,
  type LambdaEvent,
  type LambdaEventKind,
  type ApiSource,
  type SqsSource,
} from "./declaration";
import { ScheduleGroup } from "src/event-bridge/schedule-group";
import { isLambdaGroup, LambdaGroup, type LambdaConfig } from "./lambda";
import { assertId, type NameSafe } from "src/id";

export type LambdaDeclarationConfig<
  Id extends string,
  E extends LambdaEvent | undefined,
  Env extends EnvVars,
> = {
  /**
   * Names the function and its role, zip, policy and log group, and keys them
   * in state. Changing the id replaces the function, so keep it stable.
   */
  id: NameSafe<Id>;
  /**
   * The function's name in AWS, in place of the id. The function is named
   * `<app>--<stage>--<name>`. Changing the name replaces the function. Must
   * be name-safe.
   */
  name?: string;
  /**
   * The events that the function receives, such as
   * `() => sqs.bind(orderQueue)`.
   */
  event?: () => E;
  /**
   * The values that the function's code reads, by name, such as
   * `() => ({ QUEUE_URL: ordersQueue.url })`. Deploy sets each one as an
   * environment variable of the function, and `env()` reads them. Return an
   * object literal with no spread or computed keys.
   */
  env?: () => Env;
  /** Statements to add to the role's inline policy. */
  policy?: () => aws.lambda.PolicyStatement[];
  runtime?: LambdaConfig["runtime"];
  /** Seconds the function may run for each event. Lambda's default is 3. */
  timeout?: number;
  /** Megabytes of memory for the function. Lambda's default is 128. */
  memory?: number;
};

type Registered = {
  build: () => LambdaGroup;
  kind: () => LambdaEventKind;
  event: () => LambdaEvent | undefined;
};

// Holds a declaration's registration, on the declaration. Two installed
// copies of this package each have their own module state, so a registry in
// one copy can't find a declaration from the other. `Symbol.for` returns the
// same symbol in both, as for LambdaGroup.
const registration = Symbol.for("@notation/aws/LambdaDeclaration");

const registeredOf = (value: unknown): Registered | undefined =>
  typeof value === "object" && value !== null && registration in value
    ? (value as { [registration]: Registered })[registration]
    : undefined;

/**
 * Declares the Lambda function that its module deploys as. The module
 * exports `handler`, which Lambda calls with each event.
 *
 * The function's resources are made when infra has finished loading, or when
 * infra first wires the declaration, so the options can refer to infra
 * modules that import this one.
 * @declaration shared: id, event, env; keys: env; entry: handler
 */
export function $lambda<
  const Id extends string,
  E extends LambdaEvent | undefined = undefined,
  Env extends EnvVars = {},
>(config: LambdaDeclarationConfig<Id, E, Env>): Lambda<E, Env> {
  assertId("$lambda", config.id);
  const declaration = {
    id: config.id,
    env: () => (config.env?.() ?? {}) as Env,
    decode: createDecode(config),
  } as unknown as Lambda<E, Env>;

  let group: LambdaGroup | undefined;
  // The group is assigned before the event's resources are made, so one
  // that throws doesn't build a second group on the next call.
  const build = () => {
    if (group) return group;
    group = buildGroup(declaration, config);
    subscribeQueue(group, config);
    addRoute(group, config);
    addSchedule(group, config);
    return group;
  };
  Object.defineProperty(declaration, registration, {
    value: {
      build,
      kind: () => config.event?.()?.kind ?? "none",
      event: () => config.event?.(),
    } satisfies Registered,
  });
  if (getActiveResourceCollection()) onEvaluationEnd(build);
  return declaration;
}

function buildGroup(
  declaration: Lambda<any, any>,
  config: Omit<
    LambdaDeclarationConfig<string, LambdaEvent | undefined, EnvVars>,
    "id"
  > & { id: string },
): LambdaGroup {
  const record = getDeclaredIn(declaration);
  if (!record) {
    throw new Error(
      `The Lambda "${config.id}" has no module. The infra build records the module of each $lambda call; run the infra through notation compile, plan or deploy.`,
    );
  }
  const modulePath = fromProjectRoot(record.path);
  const group = new LambdaGroup(
    {
      id: config.id,
      name: config.name,
      code: {
        type: "file",
        path: toProjectRoot(filePaths.dist.runtime.index(modulePath)),
      },
      handler: "handler",
      runtime: config.runtime,
      timeout: config.timeout,
      memory: config.memory,
    },
    { caller: "$lambda", where: record.path },
  );
  const env = config.env?.();
  if (env && Object.keys(env).length > 0) {
    group.fn.contribute({ Environment: { Variables: env } });
  }
  const statements = config.policy?.() ?? [];
  if (statements.length > 0) {
    group.policy.contribute({ PolicyDocument: { Statement: statements } });
  }
  return group;
}

// Maps the queue of `event: () => sqs.bind(queue)` to the group.
function subscribeQueue(
  group: LambdaGroup,
  config: Omit<
    LambdaDeclarationConfig<string, LambdaEvent | undefined, EnvVars>,
    "id"
  > & { id: string },
): void {
  const event = config.event?.();
  if (event?.kind !== "sqs" || !("queue" in event)) return;
  const queue = event.queue as Partial<SqsSource> | undefined;
  if (typeof queue?.["~subscribe"] !== "function") {
    throw new Error(
      `The Lambda "${config.id}" is declared with sqs.bind(queue), but the value passed to sqs.bind() is not a queue from queue().`,
    );
  }
  queue["~subscribe"](group, event.options);
}

// Makes the route of `event: () => apiGateway.bind(api).defineRoute(options)`.
function addRoute(
  group: LambdaGroup,
  config: Omit<
    LambdaDeclarationConfig<string, LambdaEvent | undefined, EnvVars>,
    "id"
  > & { id: string },
): void {
  const event = config.event?.();
  if (event?.kind !== "apiGateway" && event?.kind !== "apiGateway-jwt") return;
  if (!event.route) return;
  const { api, ...route } = event.route;
  if (typeof (api as Partial<ApiSource>)?.["~route"] !== "function") {
    throw new Error(
      `The Lambda "${config.id}" is declared with apiGateway.bind(api), but the value passed to apiGateway.bind() is not an API from api().`,
    );
  }
  api["~route"](group, route);
}

// Makes the rule of `event: () => eventBridge.defineSchedule(options)`.
function addSchedule(
  group: LambdaGroup,
  config: Omit<
    LambdaDeclarationConfig<string, LambdaEvent | undefined, EnvVars>,
    "id"
  > & { id: string },
): void {
  const event = config.event?.();
  if (event?.kind !== "eventBridge" || !event.schedule) return;
  new ScheduleGroup(event.schedule, group, "eventBridge.defineSchedule()");
}

/**
 * A Lambda that infra can wire: a declaration, or a group from `lambda()`.
 * The return type has only optional properties, so TypeScript rejects a
 * function that returns an object with none of them, such as a queue.
 */
export type LambdaTarget<K extends LambdaEventKind = LambdaEventKind> =
  (() => { readonly "~lambda"?: { kind: K } }) | LambdaGroup;

/**
 * Finds the Lambda group of a target. A declaration is passed as a function,
 * such as `() => lambda`, because it can be in a module that is still
 * loading. `kinds` are the events the caller sends; a declaration with
 * another event fails. `caller` names the infra API in errors.
 */
export function resolveLambda(
  target: unknown,
  caller: string,
  kinds: LambdaEventKind[],
): LambdaGroup {
  if (isLambdaGroup(target)) return target;
  if (typeof target !== "function") {
    throw new Error(
      `${caller} expects a function that returns a Lambda declaration, such as \`() => lambda\`, or a Lambda group from lambda().`,
    );
  }
  const declaration = target();
  const registered = registeredOf(declaration);
  if (!registered) {
    throw new Error(
      `${caller} expects a function that returns a Lambda declaration from $lambda(), but it returned ${declaration === undefined ? "undefined" : "another value"}.`,
    );
  }
  const group = registered.build();
  const event = registered.kind();
  if (!kinds.includes(event)) {
    throw new Error(
      `${caller} sends ${kinds
        .filter((k) => k !== "none")
        .map((k) => eventNames[k])
        .join(
          " or ",
        )}, but the Lambda "${group.id}" is declared with ${event === "none" ? "no event" : `event: () => ${eventCall(registered.event()!)}`}.`,
    );
  }
  return group;
}

const eventNames: Record<LambdaEventKind, string> = {
  sqs: "sqs events",
  apiGateway: "apiGateway events",
  "apiGateway-jwt": "apiGateway events with a JWT authorizer",
  eventBridge: "eventBridge events",
  none: "any events",
};

/** The call that declares an event, as errors show it. */
export function eventCall(event: LambdaEvent): string {
  switch (event.kind) {
    case "sqs":
      return "queue" in event ? "sqs.bind(queue)" : "sqs.schema(schema)";
    case "apiGateway":
    case "apiGateway-jwt":
      if (event.route) return "apiGateway.bind(api).defineRoute(options)";
      if (event.kind === "apiGateway") return "apiGateway.schema(body)";
      return event.claims
        ? "apiGateway.schema(body).authSchema(claims)"
        : "apiGateway.schema(body).authSchema()";
    case "eventBridge":
      return event.schedule
        ? "eventBridge.defineSchedule(options)"
        : "eventBridge.schema(null)";
  }
}

/**
 * The id and the event of a target's declaration, or undefined for a group
 * from `lambda()`.
 */
export function declarationOf(
  target: unknown,
): { id: string; event: LambdaEvent | undefined } | undefined {
  if (typeof target !== "function" || isLambdaGroup(target)) return undefined;
  const declaration = target();
  const registered = registeredOf(declaration);
  return registered && { id: declaration.id, event: registered.event() };
}

/**
 * Runs `wire` when infra has finished loading, so that a declaration in a
 * module that is still loading can be resolved. Without a resource graph
 * being collected, `wire` runs at once.
 */
export function whenLoaded(wire: () => void): void {
  if (getActiveResourceCollection()) onEvaluationEnd(wire);
  else wire();
}
