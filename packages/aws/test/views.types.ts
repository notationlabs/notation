import { expectTypeOf } from "vitest";
import type {
  FunctionDeclaration,
  InfraOnly,
  InfraView,
  RuntimeOnly,
  RuntimeView,
} from "@notation/resource";
import type { APIGatewayProxyResultV2, SQSEvent } from "aws-lambda";
import { api, router } from "src/api-gateway";
import type * as lambdaModule from "src/lambda";
import {
  lambda,
  type LambdaFunction,
  type LambdaGroup,
  type RuntimeLambda,
} from "src/lambda";
import { json, lambda as runtimeLambda } from "src/lambda.fn";
import type { LambdaRef } from "src/lambda";
import { queue, type QueueGroup } from "src/sqs";
import type * as sqsModule from "src/sqs";

// Type tests of the views. `pok typecheck` checks them, including each
// `@ts-expect-error`. The functions never run.

const { handle } = runtimeLambda();

const checkout = {
  createOrder: handle.apiRequest(async () => json({ ok: true })),
  processOrder: handle.sqsEvent(async () => {}),
  helper: (n: number) => n * 2,
  region: "eu-west-2",
};

const code = { type: "file", path: "dist/runtime/checkout/index.mjs" } as const;

export function infraWiresAHandlerButCantCallIt(
  infra: InfraView<typeof checkout>,
) {
  const orders = queue({ name: "orders" });
  const todoRouter = router(api({ name: "todo-api" }));

  orders.consume(infra.processOrder);
  todoRouter.post("/orders", infra.createOrder);

  // @ts-expect-error a RuntimeRef is not callable
  infra.processOrder({ Records: [] });
  // @ts-expect-error an API handler can't consume a queue
  orders.consume(infra.createOrder);
  // @ts-expect-error an SQS handler can't serve a route
  todoRouter.get("/orders", infra.processOrder);

  expectTypeOf(infra.processOrder).toEqualTypeOf<LambdaRef<SQSEvent, void>>();
  expectTypeOf(infra.createOrder.function).toEqualTypeOf<LambdaFunction>();
}

export function infraPassesOnValuesOfAHandlersFunction(
  infra: InfraView<typeof checkout>,
) {
  const fn = infra.processOrder.function;
  queue({ name: "orders" }).consume(fn);
  lambda({ id: "caller", code, grants: [fn.grantInvoke()] });
  expectTypeOf(fn.arn).toEqualTypeOf<string>();
  // @ts-expect-error infra can't make handlers for a runtime module's function
  fn.handle.apiRequest(async () => json({ ok: true }));
}

export function infraSeesOtherExportsAsRuntimeOnly(
  infra: InfraView<typeof checkout>,
) {
  expectTypeOf(infra.helper).toEqualTypeOf<RuntimeOnly<"helper">>();
  expectTypeOf(infra.region).toEqualTypeOf<RuntimeOnly<"region">>();
  // @ts-expect-error a helper is not callable from infra
  infra.helper(1);
}

export function infraSeesAnExportedDeclarationAsItsFunction(
  infra: InfraView<{ checkoutFn: FunctionDeclaration<LambdaGroup> }>,
) {
  expectTypeOf(infra.checkoutFn).toEqualTypeOf<LambdaFunction>();
}

export function infraApisRejectPlainFunctions() {
  const orders = queue({ name: "orders" });
  // @ts-expect-error a plain function is not a RuntimeRef
  orders.consume((event: SQSEvent) => {});
  // @ts-expect-error a handler imported without an attribute is not a RuntimeRef
  orders.consume(checkout.processOrder);
  orders.consume(lambda({ id: "external", code }));
}

export async function runtimeCallsAHandler() {
  const response = await checkout.createOrder({} as any);
  expectTypeOf(response).toEqualTypeOf<APIGatewayProxyResultV2>();
}

export function runtimeReadsDataAsValues(
  infra: RuntimeView<{ orderQueue: QueueGroup }>,
) {
  expectTypeOf(infra.orderQueue.url).toEqualTypeOf<string>();
  expectTypeOf(infra.orderQueue.arn).toEqualTypeOf<string>();
  expectTypeOf(infra.orderQueue.id).toEqualTypeOf<string>();
}

export function runtimeReadsABindingOfDataWhole(
  infra: RuntimeView<{ settings: { memory: number; tags: { team: string } } }>,
) {
  expectTypeOf(infra.settings).toEqualTypeOf<{
    memory: number;
    tags: { team: string };
  }>();
}

export function runtimeDoesntSeeWhatIsntDelivered(
  infra: RuntimeView<{ orderQueue: QueueGroup }>,
) {
  // @ts-expect-error a binding's resources aren't delivered
  infra.orderQueue.resources;
  // @ts-expect-error a resource isn't delivered
  infra.orderQueue.queue;
  // @ts-expect-error a binding that isn't data doesn't deliver its config
  infra.orderQueue.config;
}

export function runtimeReadsTheArnOfALambdaGroup(
  infra: RuntimeView<{ worker: LambdaGroup }>,
) {
  expectTypeOf(infra.worker.arn).toEqualTypeOf<string>();
  // @ts-expect-error a binding that isn't data doesn't deliver its config
  infra.worker.config;
}

export function runtimeCallsGrantButNoOtherMethod(
  infra: RuntimeView<{ orderQueue: QueueGroup }>,
) {
  infra.orderQueue.grant(["SendMessage"]);
  expectTypeOf(infra.orderQueue.consume).toEqualTypeOf<InfraOnly<"consume">>();
  // @ts-expect-error consume is infra only
  infra.orderQueue.consume({} as any);
}

export function runtimeCallsFactoriesButNoOtherFunction(
  sqs: RuntimeView<typeof sqsModule>,
  aws: RuntimeView<typeof lambdaModule>,
) {
  sqs.queue({ name: "orders" }).grant(["SendMessage"]);
  expectTypeOf(aws.lambda).toEqualTypeOf<RuntimeLambda>();

  // @ts-expect-error a class is infra only
  new sqs.QueueGroup({ name: "orders" });
  // @ts-expect-error a function that isn't a factory is infra only
  aws.isLambdaGroup({});
  // @ts-expect-error a function that isn't a factory is infra only
  aws.lambdaTarget({}, "test");
}

export function infraSeesAnExportedLambdaResultAsItsFunction() {
  const checkoutFn = lambda({ id: "checkout" });
  const infra = {} as InfraView<{ checkoutFn: typeof checkoutFn }>;
  expectTypeOf(infra.checkoutFn).toEqualTypeOf<LambdaFunction>();
}

export function runtimeMakesHandlersWithTheHandleOfLambda(
  aws: RuntimeView<typeof lambdaModule>,
) {
  const { handle } = aws.lambda({ id: "checkout", timeout: 5 });
  const createOrder = handle.apiRequest(async () => json({ ok: true }));
  const infra = {} as InfraView<{ createOrder: typeof createOrder }>;
  expectTypeOf(infra.createOrder.function).toEqualTypeOf<LambdaFunction>();
}

export function runtimeSeesOnlyTheRuntimeHalfOfAFactorysResult(
  aws: RuntimeView<typeof lambdaModule>,
  sqs: RuntimeView<typeof sqsModule>,
) {
  const checkoutFn = aws.lambda({ id: "checkout" });
  checkoutFn.handle.sqsEvent(async () => {});
  // @ts-expect-error runtime code can't read its function's role
  checkoutFn.role;
  // @ts-expect-error runtime code can't read its function's resources
  checkoutFn.fn;
  // @ts-expect-error a queue made in runtime code can't be consumed there
  sqs.queue({ name: "orders" }).consume({} as any);
  // @ts-expect-error a literal id must be name-safe
  aws.lambda({ id: "bad.id" });
}

export function lambdaTakesAnIdBuiltFromInfra(
  infra: RuntimeView<{ settings: { id: string; prefix: string } }>,
  aws: RuntimeView<typeof lambdaModule>,
) {
  aws.lambda({ id: infra.settings.id });
  aws.lambda({ id: `${infra.settings.prefix}-checkout` });
  lambda({ id: infra.settings.id, code });
}
