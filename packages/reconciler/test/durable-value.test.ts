import type {
  Durable as ResourceDurable,
  DurableValue,
  Encodable,
  ToDurable,
} from "@notation/resource";
import type { Durable, DurableValue as YieldstarDurableValue } from "yieldstar";
import { expectTypeOf, it } from "vitest";

it("accepts the durable values of @notation/resource as yieldstar durable values", () => {
  expectTypeOf<DurableValue>().toExtend<Durable<DurableValue>>();
  expectTypeOf<YieldstarDurableValue>().toExtend<DurableValue>();
});

it("maps the same types to never as yieldstar", () => {
  type Value = { date: Date; bytes: Uint8Array; fn: () => void };
  expectTypeOf<ResourceDurable<Value>["date"]>().toBeNever();
  expectTypeOf<Durable<Value>["date"]>().toBeNever();
  expectTypeOf<Buffer>().not.toExtend<ResourceDurable<Uint8Array>>();
  expectTypeOf<Buffer>().not.toExtend<Durable<Uint8Array>>();
  expectTypeOf<ResourceDurable<Value>["fn"]>().toBeNever();
});

it("maps dates to strings in recorded types and keeps them in provider results", () => {
  type Value = { date: Date; dates: Date[]; bytes: Uint8Array };
  expectTypeOf<ToDurable<Value>["date"]>().toEqualTypeOf<string>();
  expectTypeOf<ToDurable<Value>["dates"]>().toEqualTypeOf<string[]>();
  expectTypeOf<Encodable<Value>["date"]>().toEqualTypeOf<Date>();
  expectTypeOf<Buffer>().not.toExtend<Encodable<Uint8Array>>();
  expectTypeOf<ToDurable<Value>>().toExtend<Durable<ToDurable<Value>>>();
});
