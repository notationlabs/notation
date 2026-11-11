import * as aws from "src/resources";
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
  /**
   * The function's reserved concurrency: the most instances that may run at
   * once, set aside from the account's limit. Without it, the function uses
   * the account's unreserved concurrency. `0` stops all invocations. AWS
   * rejects a reservation that would leave the account below its minimum
   * unreserved concurrency, and the deploy fails.
   */
  concurrency?: number;
};

type Registered = {
  build: () => LambdaGroup;
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
  // The event is evaluated once, on first use, as infra modules that it
  // refers to may still be loading when $lambda is called.
  let event: { value: LambdaEvent | undefined } | undefined;
  const getEvent = () => (event ??= { value: config.event?.() }).value;
  const declaration = {
    id: config.id,
    env: () => (config.env?.() ?? {}) as Env,
    decode: createDecode({ event: getEvent }),
  } as unknown as Lambda<E, Env>;
  let built: { group: LambdaGroup } | { error: unknown } | undefined;
  // A build that throws throws the same error on each later call, so the
  // group isn't made twice, or returned without its event's resources.
  const build = () => {
    if (!built) {
      try {
        const group = buildGroup(declaration, config);
        wireEvent(group, getEvent());
        built = { group };
      } catch (error) {
        built = { error };
      }
    }
    if ("error" in built) throw built.error;
    return built.group;
  };
  Object.defineProperty(declaration, registration, {
    value: { build, event: getEvent } satisfies Registered,
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
      concurrency: config.concurrency,
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

// Makes the resources that the event declares: the queue mapping of
// `sqs.bind(queue)`, the route of `apiGateway.bind(api).defineRoute()`, or
// the rule of `eventBridge.bind(bus).defineRule()` or
// `eventBridge.defineSchedule()`.
function wireEvent(group: LambdaGroup, event: LambdaEvent | undefined): void {
  switch (event?.kind) {
    case "sqs":
      event.queue?.["~subscribe"](group, event.options);
      return;
    case "apiGateway":
    case "apiGateway-jwt":
      if (event.route) {
        const { api, ...route } = event.route;
        api["~route"](group, route);
      }
      return;
    case "eventBridge":
      if (event.schedule) {
        new ScheduleGroup(
          event.schedule,
          group,
          "eventBridge.defineSchedule()",
        );
      }
      if (event.rule) {
        event.rule.bus["~rule"](group, event.rule.options);
      }
      return;
  }
}

/**
 * A Lambda that infra can wire: a declaration, or a group from `lambda()`.
 * The return type has only optional properties, so TypeScript rejects a
 * function that returns an object with none of them, such as a queue.
 */
export type LambdaTarget<K extends LambdaEventKind = LambdaEventKind> =
  (() => { readonly "~lambda"?: { kind: K } }) | LambdaGroup;

/**
 * Finds the Lambda group of a target, and the event of its declaration. A
 * declaration is passed as a function, such as `() => lambda`, because it can
 * be in a module that is still loading. A declaration fails when its event
 * has another kind than `kind`, or when it wires itself to a queue, a route,
 * a rule or a schedule, which the caller would wire a second time. The checks run
 * before the group is built, so a rejected declaration wires nothing.
 */
export function resolveLambda(
  target: unknown,
  // The function that wires the Lambda, such as `route()`, for errors.
  caller: string,
  kind: Exclude<LambdaEventKind, "none">,
): { group: LambdaGroup; event: LambdaEvent | undefined } {
  if (isLambdaGroup(target)) return { group: target, event: undefined };
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
  const event = registered.event();
  const lambda = `the Lambda "${(declaration as Lambda<any, any>).id}"`;
  if (event && event.kind !== kind) {
    throw new Error(
      `${caller} sends ${eventNames[kind]}, but ${lambda} is declared with event: () => ${eventCall(event)}.`,
    );
  }
  const wired = event && wiredBy(event);
  if (wired) {
    throw new Error(
      `${caller} can't wire ${lambda}, because the Lambda makes its own ${wired.noun} in its declaration, with event: () => ${eventCall(event)}. Make the ${wired.noun} in one place: remove the ${caller} call, or declare the Lambda with event: () => ${wired.instead}.`,
    );
  }
  return { group: registered.build(), event };
}

// What an event that wires its own Lambda makes, and the event to declare
// in its place.
function wiredBy(
  event: LambdaEvent,
): { noun: string; instead: string } | undefined {
  switch (event.kind) {
    case "sqs":
      return event.queue
        ? { noun: "queue mapping", instead: "sqs.schema(schema)" }
        : undefined;
    case "apiGateway":
    case "apiGateway-jwt":
      return event.route
        ? { noun: "route", instead: "apiGateway.schema(body)" }
        : undefined;
    case "eventBridge":
      if (event.schedule) {
        return { noun: "schedule", instead: "eventBridge.schema(null)" };
      }
      return event.rule
        ? { noun: "rule", instead: "eventBridge.schema(schema)" }
        : undefined;
  }
}

const eventNames: Record<Exclude<LambdaEventKind, "none">, string> = {
  sqs: "sqs events",
  apiGateway: "apiGateway events",
  "apiGateway-jwt": "apiGateway events with a JWT authorizer",
  eventBridge: "eventBridge events",
};

/** The call that declares an event, as errors show it. */
export function eventCall(event: LambdaEvent): string {
  switch (event.kind) {
    case "sqs":
      return event.queue ? "sqs.bind(queue)" : "sqs.schema(schema)";
    case "apiGateway":
    case "apiGateway-jwt":
      if (event.route) return "apiGateway.bind(api).defineRoute(options)";
      if (event.kind === "apiGateway") return "apiGateway.schema(body)";
      return event.claims
        ? "apiGateway.schema(body).authSchema(claims)"
        : "apiGateway.schema(body).authSchema()";
    case "eventBridge":
      if (event.schedule) return "eventBridge.defineSchedule(options)";
      if (event.rule) return "eventBridge.bind(bus).defineRule(options)";
      return event.schema
        ? "eventBridge.schema(schema)"
        : "eventBridge.schema(null)";
  }
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
