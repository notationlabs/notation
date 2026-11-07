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
} from "./declaration";
import { isLambdaGroup, LambdaGroup, type LambdaConfig } from "./lambda";
import { assertLambdaId, type NameSafe } from "./lambda-id";

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
  /** The events that the function receives, such as `() => sqs(Order)`. */
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

type Registered = { build: () => LambdaGroup; kind: () => LambdaEventKind };

const declarations = new WeakMap<object, Registered>();

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
  assertLambdaId(config.id);
  const declaration = {
    id: config.id,
    env: () => (config.env?.() ?? {}) as Env,
    decode: createDecode(config),
  } as unknown as Lambda<E, Env>;

  let group: LambdaGroup | undefined;
  const build = () => (group ??= buildGroup(declaration, config));
  declarations.set(declaration, {
    build,
    kind: () => config.event?.()?.kind ?? "none",
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
  const group = new LambdaGroup({
    id: config.id,
    code: {
      type: "file",
      path: toProjectRoot(filePaths.dist.runtime.index(modulePath)),
    },
    handler: "handler",
    runtime: config.runtime,
    timeout: config.timeout,
    memory: config.memory,
  });
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
  const registered = declarations.get(declaration);
  if (!registered) {
    throw new Error(
      `${caller} expects a function that returns a Lambda declaration from $lambda(), but it returned ${declaration === undefined ? "undefined" : "another value"}.`,
    );
  }
  const group = registered.build();
  const event = registered.kind();
  if (!kinds.includes(event)) {
    throw new Error(
      `${caller} sends ${kinds.filter((k) => k !== "none").join(" or ")} events, but the Lambda "${group.id}" is declared with ${event === "none" ? "no event" : `event: () => ${event}()`}.`,
    );
  }
  return group;
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
