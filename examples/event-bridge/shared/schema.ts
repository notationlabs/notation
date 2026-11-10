import * as v from "valibot";

export const OrderPlaced = v.object({
  orderId: v.string(),
  total: v.number(),
});

export const OrderShipped = v.object({
  orderId: v.string(),
  carrier: v.string(),
});
