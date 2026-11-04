import * as aws from "@notation/aws.iac";
import * as std from "@notation/std.iac";
import {
  captureCallSite,
  createHandlerRef,
  declareRuntimeFunction,
  describeStandIn,
  getActiveResourceCollection,
  isDeferred,
  isHandlerRef,
  isStandIn,
  onEvaluationEnd,
  resolveRuntimeTarget,
  type FunctionDeclaration,
  type Grant,
} from "@notation/resource";
import type { DispatchEntry } from "@notation/aws.iac/shared";
import path from "path";
import { awsName } from "src/naming";
import { handlerKinds, type Handle, type HandlerKind } from "src/shared/handle";

export type { Handle, LambdaHandler } from "src/shared/handle";
import { assertLambdaId, type NameSafe } from "./lambda-id";

export type LambdaConfig = {
  /**
   * Names the function and its role, zip, policy and log group, and keys them
   * in state. The function is named `<app>--<stage>--<id>` in AWS. Changing the
   * id replaces the function, so keep it stable.
   *
   * Must be name-safe: 1 to 64 letters, digits, hyphens or underscores.
   */
  id: string;
  /**
   * The export of the code that Lambda calls with every event. Defaults to
   * `handler`.
   */
  handler?: string;
  /**
   * The bundle to deploy, for a function that runs external code. Leave it
   * out in a runtime module: the compiler bundles the module's handlers to
   * `dist/functions/<id>/index.mjs`.
   */
  code?: {
    type: "file" | "zip";
    path: string;
  };
  runtime?: aws.lambda.LambdaFunctionConfig["Runtime"];
  /** Seconds the function may run for each event. Lambda's default is 3. */
  timeout?: number;
  /** Megabytes of memory for the function. Lambda's default is 128. */
  memory?: number;
  /**
   * Policy statements for the function's role, such as
   * `orderQueue.grant(["SendMessage"])`.
   */
  grants?: aws.lambda.PolicyStatement[];
};

// Marks a LambdaGroup. Two installed copies of this package have different
// LambdaGroup classes, so `instanceof` can't recognise a group from the
// other copy. `Symbol.for` returns the same symbol in both.
const lambdaGroupMark = Symbol.for("@notation/aws/LambdaGroup");

export class LambdaGroup extends aws.AwsResourceGroup<LambdaConfig> {
  readonly fn: aws.lambda.LambdaFunctionInstance;
  readonly role: aws.lambda.LambdaIamRoleInstance;
  #handle?: Handle;

  get [lambdaGroupMark]() {
    return true;
  }

  constructor(config: LambdaConfig) {
    assertLambdaId(config.id);
    assertUniqueLambdaId(config.id);
    super("Lambda", config.id, config);
    const { fn, role } = build(this, config);
    this.fn = fn;
    this.role = role;
    if (config.grants && config.grants.length > 0) {
      this.policy.contribute({
        PolicyDocument: { Statement: config.grants },
      });
    }
  }

  /**
   * The function's ARN. It is an output value, filled in at deploy. A getter,
   * so that serialising the group doesn't turn it into a string.
   */
  get arn(): string {
    return this.fn.outputValue("FunctionArn");
  }

  /**
   * A policy statement that allows invoking this function, for the grants of
   * another function or a role's policy.
   */
  grantInvoke(): Grant<aws.lambda.PolicyStatement> {
    return {
      Effect: "Allow",
      Action: ["lambda:InvokeFunction"],
      Resource: this.arn,
    };
  }

  /**
   * Makes the handlers of a function that a runtime module declares. Each
   * handler that a runtime module exports is dispatched to by the function.
   * A function that runs external code has no `handle`.
   */
  get handle(): Handle {
    if (!runtimeFunctions.has(this)) {
      throw new Error(
        `lambda "${this.id}" runs the external code at ${this.config.code!.path}, so it has no handle. Leave out code to declare a function in a runtime module.`,
      );
    }
    return (this.#handle ??= makeHandle(this));
  }

  /**
   * The role's inline policy. Its statements are collected: add one with
   * `policy.contribute({ PolicyDocument: { Statement: [statement] } })`.
   *
   * IAM rejects a policy with no statements, so the group adds the policy
   * only when code first reads `policy` to contribute to it.
   */
  get policy(): aws.lambda.LambdaRolePolicyInstance {
    return this.addOnce(aws.lambda.LambdaRolePolicy, `${this.id}-role-policy`, {
      config: {
        RoleName: this.role.config.RoleName,
        PolicyName: `${this.id}-role-policy`,
      },
      dependencies: { role: this.role },
    });
  }

  /**
   * Adds an entry to the function's dispatch map, which sends events that
   * match the entry to one export. `bindingId` is the ID of the binding that
   * adds the entry, such as a route or an event source mapping.
   */
  addDispatchEntry(bindingId: string, entry: DispatchEntry): void {
    this.fn.contribute({
      Environment: { Runtime: { dispatch: { [bindingId]: entry } } },
    });
  }
}

function makeHandle(group: LambdaGroup): Handle {
  return Object.fromEntries(
    Object.entries(handlerKinds).map(([method, kind]) => {
      const make = (_handler: unknown) => createHandlerRef(kind, group, make);
      return [method, make];
    }),
  ) as unknown as Handle;
}

export function isLambdaGroup(value: unknown): value is LambdaGroup {
  return (value as any)?.[lambdaGroupMark] === true;
}

/** The Lambda group that a target invokes, and the export to dispatch to. */
export type ResolvedLambdaTarget = { group: LambdaGroup; export?: string };

/**
 * Wires `target` once it is known. A handler of a runtime module is a
 * stand-in until the runtime modules are linked, so while infra is being
 * evaluated the wiring runs when evaluation ends. Outside an evaluation it
 * runs now.
 *
 * @param caller Names the infra API in errors, such as `route()`.
 * @param kinds The handler kinds that the API can invoke.
 * @param below The infra API that the user's code called, which names the
 * call site in errors.
 */
export function wireLambdaTarget(
  target: unknown,
  caller: string,
  kinds: readonly HandlerKind[],
  below: Function,
  wire: (target: ResolvedLambdaTarget) => void,
): void {
  if (
    !isStandIn(target) &&
    !isDeferred(target) &&
    !isHandlerRef(target) &&
    !isLambdaGroup(target)
  ) {
    throw new Error(
      `${caller} expects a handler exported from a runtime module, or a Lambda group from lambda(). A runtime module calls lambda() and exports the handlers that its handle makes.`,
    );
  }
  const site = captureCallSite(below, { skipLibraryFrames: true });
  const run = () => wire(resolveLambdaTarget(target, caller, kinds, site));
  if (getActiveResourceCollection()) onEvaluationEnd(run);
  else run();
}

function resolveLambdaTarget(
  target: unknown,
  caller: string,
  kinds: readonly HandlerKind[],
  site: string | undefined,
): ResolvedLambdaTarget {
  const resolved = resolveRuntimeTarget(target);
  if (isLambdaGroup(resolved)) return { group: resolved };
  const at = site ? ` at ${site}` : "";
  if (!isHandlerRef(resolved)) {
    throw new Error(
      `${caller}${at} expects a handler, but ${describeStandIn(target) ?? "its target"} is not a handler or a Lambda group.`,
    );
  }
  if (!kinds.includes(resolved.kind as HandlerKind)) {
    throw new Error(
      `${caller}${at} invokes ${kinds.join(" or ")} handlers, but ${resolved.export} from ${resolved.module} is a ${resolved.kind} handler.`,
    );
  }
  if (!isLambdaGroup(resolved.function)) {
    throw new Error(`${caller}${at} expects a handler of a Lambda function.`);
  }
  return { group: resolved.function, export: resolved.export };
}

/**
 * What `lambda()` returns. Infra imports a runtime module
 * `with { type: "runtime" }`, and sees an exported `lambda()` result as its
 * `LambdaGroup`.
 */
export type LambdaDeclaration = LambdaGroup & FunctionDeclaration<LambdaGroup>;

/**
 * Declares a Lambda function. `id` must be a name-safe string literal; see
 * `NameSafe`.
 *
 * Called in a runtime module without `code`, it declares the function that
 * the module's handlers run in. Destructure `handle` to make them.
 */
export function lambda<const Id extends string>(
  config: Omit<LambdaConfig, "id"> & { id: NameSafe<Id> },
): LambdaDeclaration {
  const group = new LambdaGroup(
    config.code ? config : { ...config, code: runtimeCode(config.id) },
  );
  if (!config.code) {
    runtimeFunctions.add(group);
    declareRuntimeFunction(
      group,
      {
        id: config.id,
        service: "aws/lambda",
        bundle: runtimeBundle(config.id),
      },
      lambda,
      (outputs) =>
        group.fn.contribute({ Environment: { Runtime: { outputs } } }),
    );
  }
  return group as LambdaDeclaration;
}

// The groups that `lambda()` declared without code, whose handlers the
// compiler bundles.
const runtimeFunctions = new WeakSet<LambdaGroup>();

const runtimeBundle = (id: string) => `dist/functions/${id}/index.mjs`;
const runtimeCode = (id: string) => ({
  type: "file" as const,
  path: runtimeBundle(id),
});

// IAM role names are unique regardless of case, so compare IDs in lower case
function assertUniqueLambdaId(id: string) {
  const collection = getActiveResourceCollection();
  if (!collection) return;
  const clash = collection.graph.resourceGroups.find(
    (group) =>
      isLambdaGroup(group) && group.id.toLowerCase() === id.toLowerCase(),
  );
  if (clash) {
    const existing = clash.id;
    throw new Error(
      existing === id
        ? `Duplicate lambda id "${id}": another lambda in this deployment already uses it. Give each lambda a unique id.`
        : `Duplicate lambda id "${id}": it clashes with "${existing}", because AWS IAM role names ignore case. Give each lambda a unique id.`,
    );
  }
}

const build = (functionGroup: LambdaGroup, config: LambdaConfig) => {
  const filePath = config.code!.path;
  const lambdaId = config.id;

  let zipFile: std.fs.ZipFileInstance | std.fs.FileInstance;

  if (config.code!.type === "file") {
    zipFile = functionGroup.add(
      new std.fs.Zip(`${lambdaId}-zip`, {
        config: { sourceFilePath: filePath },
      }),
    );
  } else {
    zipFile = functionGroup.add(
      new std.fs.File(`${lambdaId}-zip`, {
        config: { filePath },
      }),
    );
  }

  const role = functionGroup.add(
    new aws.lambda.LambdaIamRole(`${lambdaId}-role`, {
      config: {
        RoleName: awsName("iamRole", `${lambdaId}-role`),
      },
    }),
  );

  functionGroup.add(
    new aws.lambda.LambdaRolePolicyAttachment(`${lambdaId}-policy`, {
      dependencies: { role },
    }),
  );

  const fileName = path.parse(filePath).name;
  const runtime = config.runtime || "nodejs22.x";

  const lambdaResource = functionGroup.add(
    new aws.lambda.LambdaFunction(lambdaId, {
      config: {
        FunctionName: awsName("lambdaFunction", lambdaId),
        Handler: `${fileName}.${config.handler ?? "handler"}`,
        Runtime: runtime,
        Timeout: config.timeout,
        MemorySize: config.memory,
        // todo: make this configurable and remove it as a default
        ReservedConcurrentExecutions: 1,
      },
      dependencies: {
        role,
        zipFile,
      },
    }),
  );

  functionGroup.add(
    new aws.lambda.LambdaLogGroup(`${lambdaId}-log-group`, {
      config: { retentionInDays: 30 },
      dependencies: { lambda: lambdaResource },
    }),
  );

  return { fn: lambdaResource, role };
};
