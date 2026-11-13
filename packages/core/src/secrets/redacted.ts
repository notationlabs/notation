const INSPECT_SYMBOL = Symbol.for("nodejs.util.inspect.custom");
const REDACTED_BRAND = Symbol.for("@notation/core/Redacted");

/**
 * Wraps a sensitive value so accidental string coercion, template
 * interpolation, and JSON serialization throw, while `console.log` and
 * `util.inspect` print `Redacted(<hidden>)`. Call `.unwrap()` to read the
 * underlying value explicitly.
 */
export class Redacted<T = string> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  unwrap(): T {
    return this.#value;
  }

  toString(): never {
    throw new TypeError(
      "Cannot convert Redacted value to a string; call .unwrap() explicitly",
    );
  }

  valueOf(): never {
    throw new TypeError(
      "Cannot convert Redacted value to a primitive; call .unwrap() explicitly",
    );
  }

  toJSON(): never {
    throw new TypeError(
      "Cannot serialize Redacted value to JSON; call .unwrap() explicitly",
    );
  }

  [Symbol.toPrimitive](): never {
    throw new TypeError(
      "Cannot coerce Redacted value to a primitive; call .unwrap() explicitly",
    );
  }

  [INSPECT_SYMBOL](): string {
    return "Redacted(<hidden>)";
  }

  static is<T = unknown>(value: unknown): value is Redacted<T> {
    return (
      value instanceof Redacted ||
      (typeof value === "object" &&
        value !== null &&
        REDACTED_BRAND in value)
    );
  }
}

Object.defineProperty(Redacted.prototype, REDACTED_BRAND, {
  value: true,
  enumerable: false,
});
