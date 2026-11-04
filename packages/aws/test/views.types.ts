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
import { lambda, type LambdaGroup } from "src/lambda";
import { handle, json } from "src/lambda.fn";
import type { LambdaRef } from "src/lambda";
import { queue, type QueueGroup } from "src/sqs";
import type * as sqsModule from "src/sqs";

// Type tests of the views. `pok typecheck` checks them, including each
// `@ts-expect-error`. The functions never run.

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
  expectTypeOf(infra.createOrder.function).toEqualTypeOf<LambdaGroup>();
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
  expectTypeOf(infra.checkoutFn).toEqualTypeOf<LambdaGroup>();
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
  expectTypeOf(sqs.queue).toEqualTypeOf<typeof queue>();
  expectTypeOf(aws.lambda).toEqualTypeOf<typeof lambda>();

  // @ts-expect-error a class is infra only
  new sqs.QueueGroup({ name: "orders" });
  // @ts-expect-error a function that isn't a factory is infra only
  aws.resolveLambdaTarget({}, "test");
  // @ts-expect-error a function that isn't a factory is infra only
  aws.isLambdaGroup({});
}
