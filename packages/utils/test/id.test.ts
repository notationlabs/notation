import { describe, expect, expectTypeOf, it } from "vitest";
import { assertId, type IdOption, type NameSafe } from "../src";

// Stands for a resource function, such as kvJson(), that checks its id.
function resource<const Id extends string = never>(config: {
  id: IdOption<Id>;
}): string {
  assertId("resource()", config.id);
  return config.id;
}

// The id of a caller, such as a group that builds ids from its own.
const caller: string = "orders";

describe("NameSafe", () => {
  it("passes a name-safe string literal", () => {
    expectTypeOf<NameSafe<"flags">>().toEqualTypeOf<"flags">();
    expectTypeOf<NameSafe<"a-B_9">>().toEqualTypeOf<"a-B_9">();
    expect(resource({ id: "flags" })).toBe("flags");
  });

  it("refuses a string literal that is not name-safe", () => {
    expectTypeOf<
      NameSafe<"flags.v2">
    >().toEqualTypeOf<`Error: "flags.v2" is not name-safe; use 1 to 64 letters (A-Z, a-z), digits, hyphens or underscores`>();
    expectTypeOf<NameSafe<"">>().toExtend<`Error: ${string}`>();
    expectTypeOf<
      NameSafe<Uppercase<"a"> | "b c">
    >().toExtend<`Error: ${string}`>();
    // 64 characters pass and 65 don't.
    expectTypeOf<
      NameSafe<"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">
    >().toEqualTypeOf<"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">();
    expectTypeOf<
      NameSafe<"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">
    >().toExtend<`Error: ${string}`>();
    // @ts-expect-error dots are not name-safe
    expect(() => resource({ id: "flags.v2" })).toThrow(
      'Invalid resource() id "flags.v2"',
    );
  });

  it("passes a template literal type whose fixed parts are name-safe", () => {
    expectTypeOf<
      NameSafe<`${string}-config`>
    >().toEqualTypeOf<`${string}-config`>();
    expectTypeOf<
      NameSafe<`prefix-${string}`>
    >().toEqualTypeOf<`prefix-${string}`>();
    expectTypeOf<
      NameSafe<`a${number}_${string}`>
    >().toEqualTypeOf<`a${number}_${string}`>();
    expectTypeOf<NameSafe<`${number}`>>().toEqualTypeOf<`${number}`>();
    expect(resource({ id: `${caller}-config` })).toBe(`${caller}-config`);
  });

  it("refuses a template literal type with a fixed part that is not name-safe", () => {
    expectTypeOf<
      NameSafe<`${string}.config`>
    >().toEqualTypeOf<`Error: the fixed parts of a template id must be name-safe; use 1 to 64 letters (A-Z, a-z), digits, hyphens or underscores`>();
    expectTypeOf<NameSafe<`a:${string}`>>().toExtend<`Error: ${string}`>();
    // @ts-expect-error a dot is not name-safe
    expect(() => resource({ id: `${caller}.config` })).toThrow(
      `Invalid resource() id "${caller}.config"`,
    );
  });

  it("passes plain string, and leaves it to the runtime check", () => {
    expectTypeOf<NameSafe<string>>().toEqualTypeOf<string>();
    const id: string = "flags";
    expect(resource({ id })).toBe("flags");
  });

  it("still throws at runtime for a bad id that the type lets through", () => {
    const id: string = "bad id";
    expect(() => resource({ id })).toThrow('Invalid resource() id "bad id"');
    expect(() => resource({ id: `${id}-config` })).toThrow(
      'Invalid resource() id "bad id-config"',
    );
    const long = "a".repeat(60);
    expect(() => resource({ id: `${long}-config` })).toThrow(
      `Invalid resource() id "${long}-config"`,
    );
    expect(() => resource({ id: "" as string })).toThrow(
      "resource() requires an id",
    );
  });
});
