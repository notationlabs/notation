import { expect, it } from "vitest";
import {
  createFunctionEntry,
  createInfraEntry,
  createStandInModule,
} from "src/codegen/codegen";

it("creates a stand-in module with one stand-in per export", () => {
  expect(createStandInModule("runtime/checkout.ts", ["createOrder", "delete"]))
    .toBe(`import { createStandIn } from "notation:runtime-link";
const __notationStandIn0 = createStandIn("runtime/checkout.ts", "createOrder");
export { __notationStandIn0 as createOrder };
const __notationStandIn1 = createStandIn("runtime/checkout.ts", "delete");
export { __notationStandIn1 as delete };
`);
});

it("creates an infra entry that evaluates infra, then the stripped copies, then links", () => {
  expect(
    createInfraEntry("/project/infra/main.ts", [
      { path: "/project/runtime/checkout.ts", module: "runtime/checkout.ts" },
    ]),
  ).toBe(`export * from "/project/infra/main.ts";
import { linkRuntimeModules } from "notation:runtime-link";
import * as __notationStandIns0 from "notation-standin:/project/runtime/checkout.ts" with { type: "runtime" };
import * as __notationRuntime0 from "notation-stripped:/project/runtime/checkout.ts";
linkRuntimeModules([
  { module: "runtime/checkout.ts", standIns: __notationStandIns0, exports: __notationRuntime0 },
]);
`);
});

it("creates a function entry that dispatches to the function's handlers", () => {
  expect(
    createFunctionEntry(
      {
        id: "checkout",
        service: "aws/lambda",
        bundle: "dist/functions/checkout/index.mjs",
        handlers: [
          { module: "runtime/checkout.ts", export: "createOrder", kind: "api" },
          { module: "runtime/refunds.ts", export: "refund", kind: "sqs" },
        ],
      },
      (module) => `/project/${module}`,
    ),
  )
    .toBe(`import { createOrder as __notationHandler0 } from "/project/runtime/checkout.ts";
import { refund as __notationHandler1 } from "/project/runtime/refunds.ts";
import { createDispatcher } from "@notation/aws/lambda.fn";
export const handler = createDispatcher({
  "createOrder": __notationHandler0,
  "refund": __notationHandler1,
});
`);
});
