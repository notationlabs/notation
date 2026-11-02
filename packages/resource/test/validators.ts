import type { StandardSchemaV1 } from "src";

/**
 * A minimal Standard Schema validator. The tests use these rather than a
 * validator library, so they rely only on the interface the engine calls.
 */
export function check<T>(
  test: (value: unknown) => boolean,
  message: string,
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) =>
        test(value) ? { value: value as T } : { issues: [{ message }] },
    },
  };
}

export const string = () =>
  check<string>((value) => typeof value === "string", "Expected a string");

export const number = () =>
  check<number>(
    (value) => typeof value === "number" && !Number.isNaN(value),
    "Expected a number",
  );

export const boolean = () =>
  check<boolean>((value) => typeof value === "boolean", "Expected a boolean");

export const object = <T>() =>
  check<T>(
    (value) => typeof value === "object" && value !== null,
    "Expected an object",
  );

/** Wraps a validator so that it resolves its result asynchronously. */
export function async<T>(
  inner: StandardSchemaV1<unknown, T>,
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      ...inner["~standard"],
      validate: async (value) => inner["~standard"].validate(value),
    },
  };
}
