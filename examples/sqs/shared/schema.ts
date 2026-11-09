import * as v from "valibot";

export const Order = v.object({
  orderId: v.string(),
  quantity: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const Refund = v.object({
  orderId: v.string(),
  reason: v.string(),
});

// The order queue moves messages that fail to decode to its dead-letter
// queue, so the dead-letter queue accepts any JSON value.
export const DeadLetter = v.unknown();
