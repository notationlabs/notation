import type {
  Durable as ResourceDurable,
  DurableValue,
} from "@notation/resource";
import type { Durable, DurableValue as YieldstarDurableValue } from "yieldstar";
import { expectTypeOf, it } from "vitest";

it("accepts the durable values of @notation/resource as yieldstar durable values", () => {
  expectTypeOf<DurableValue>().toExtend<Durable<DurableValue>>();
  expectTypeOf<YieldstarDurableValue>().toExtend<DurableValue>();
});

it("keeps dates, maps, sets and bigints as yieldstar does", () => {
  type Value = {
    date: Date;
    dates: Date[];
    map: Map<string, Date>;
    set: Set<number>;
    big: bigint;
  };
  expectTypeOf<ResourceDurable<Value>["date"]>().toEqualTypeOf<Date>();
  expectTypeOf<Durable<Value>["date"]>().toEqualTypeOf<Date>();
  expectTypeOf<ResourceDurable<Value>["dates"]>().toEqualTypeOf<Date[]>();
  expectTypeOf<ResourceDurable<Value>["map"]>().toEqualTypeOf<
    Map<string, Date>
  >();
  expectTypeOf<ResourceDurable<Value>["set"]>().toEqualTypeOf<Set<number>>();
  expectTypeOf<ResourceDurable<Value>["big"]>().toEqualTypeOf<bigint>();
  expectTypeOf<ResourceDurable<Value>>().toExtend<Durable<Value>>();
});

it("maps the same types to never as yieldstar", () => {
  type Value = { bytes: Uint8Array; fn: () => void };
  expectTypeOf<Buffer>().not.toExtend<ResourceDurable<Uint8Array>>();
  expectTypeOf<Buffer>().not.toExtend<Durable<Uint8Array>>();
  expectTypeOf<ResourceDurable<Value>["fn"]>().toBeNever();
  expectTypeOf<Durable<Value>["fn"]>().toBeNever();
});
