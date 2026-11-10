import { eventBus, rule } from "@notation/aws/event-bridge";
import { lambda as recordShipment } from "runtime/record-shipment";

export const ordersBus = eventBus({ id: "orders" });

rule({
  id: "order-shipped",
  bus: ordersBus,
  pattern: { source: ["shop"], "detail-type": ["OrderShipped"] },
  target: () => recordShipment,
});
