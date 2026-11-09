import * as v from "valibot";

export const Order = v.object({
  orderId: v.string(),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const Refund = v.object({
  orderId: v.string(),
  reason: v.string(),
});
