import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { clearOutputs, setOutputs } from "@notation/aws/testing";
import { createOrder } from "./checkout";
import { sent } from "./sqs-client";

const request = { routeKey: "POST /orders", body: "{}" } as any;

beforeEach(() => {
  clearOutputs();
  sent.length = 0;
});

test("createOrder sends the order to the queue's URL", async () => {
  setOutputs({ "infra/orders#orderQueue.url": "https://sqs.test/orders" });
  const res = await createOrder(request, {} as any);
  assert.deepEqual(res, { statusCode: 200, body: '{"ok":true}' });
  assert.deepEqual(sent, [{ url: "https://sqs.test/orders", body: "{}" }]);
});

test("a dynamic import of infra serves the values set with setOutputs", async () => {
  setOutputs({ "infra/orders#orderQueue.url": "https://sqs.test/orders" });
  const { orderQueue } = await import("../infra/orders", {
    with: { type: "infra" },
  });
  assert.equal(orderQueue.url, "https://sqs.test/orders");
});

test("reading an unset output names its key", async () => {
  await assert.rejects(createOrder(request, {} as any), {
    message: /No output is set for "infra\/orders#orderQueue\.url"/,
  });
});
