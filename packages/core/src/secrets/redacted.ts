import { SCRUBBED } from "@notation/utils";

const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

export const REDACTED_PLACEHOLDER = `Redacted(${SCRUBBED})`;

export class RedactedValueError extends Error {
  constructor(use: string) {
    super(
      `A Redacted value can't be ${use}. Call unwrap() where the value is sent, such as in a request body.`,
    );
    this.name = "RedactedValueError";
  }
}

/**
 * Holds a secret value. Code that builds a value to send somewhere, such as a
 * template literal, `String(value)` or `JSON.stringify`, throws, because a
 * placeholder there would be sent as if it were the value. `console.log`
 * and `util.inspect` print `Redacted(<hidden>)`. `unwrap()` returns the value.
 */
export class Redacted<T = string> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  unwrap(): T {
    return this.#value;
  }

  [Symbol.toPrimitive](): never {
    throw new RedactedValueError("turned into a string or a number");
  }

  toString(): never {
    throw new RedactedValueError("turned into a string");
  }

  toJSON(): never {
    throw new RedactedValueError("turned into JSON");
  }

  [inspectCustom](): string {
    return REDACTED_PLACEHOLDER;
  }

  static is(value: unknown): value is Redacted<unknown> {
    // Checks the shape, not the class, so that a value from another copy of
    // this package counts.
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { unwrap?: unknown }).unwrap === "function" &&
      inspectCustom in value
    );
  }
}
