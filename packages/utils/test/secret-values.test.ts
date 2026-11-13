import { afterEach, describe, expect, it } from "vitest";
import {
  clearSecretValues,
  recordSecretValue,
  scrubError,
  scrubSecretValues,
} from "../src";

afterEach(() => clearSecretValues());

describe("scrubSecretValues", () => {
  it("leaves text as it is when no value is recorded", () => {
    expect(scrubSecretValues("sk_live_123")).toBe("sk_live_123");
  });

  it("removes a recorded value, its base64 form and its JSON-escaped form", () => {
    const value = 'sk_"live"\n123';
    recordSecretValue(value);

    const base64 = Buffer.from(value).toString("base64");
    const escaped = JSON.stringify(value).slice(1, -1);
    expect(
      scrubSecretValues(`raw ${value}, base64 ${base64}, json ${escaped}`),
    ).toBe("raw <hidden>, base64 <hidden>, json <hidden>");
  });

  it("replaces a value that contains another value whole", () => {
    recordSecretValue("abc");
    recordSecretValue("abcdef");

    expect(scrubSecretValues("x abcdef y abc")).toBe("x <hidden> y <hidden>");
  });

  it("ignores an empty value", () => {
    recordSecretValue("");

    expect(scrubSecretValues("text")).toBe("text");
  });
});

describe("scrubError", () => {
  it("scrubs the message and stack of an error and of its causes, and keeps its class", () => {
    recordSecretValue("sk_live_123");
    class ApiError extends Error {}
    const cause = new Error("echoed sk_live_123");
    const error = new ApiError("failed with sk_live_123", { cause });
    const aggregate = new AggregateError([error], "many");

    expect(scrubError(aggregate)).toBe(aggregate);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe("failed with <hidden>");
    expect(error.stack).not.toContain("sk_live_123");
    expect(cause.message).toBe("echoed <hidden>");
  });

  it("stops at an error that holds itself", () => {
    recordSecretValue("sk_live_123");
    const error = new Error("sk_live_123") as Error & { cause?: unknown };
    error.cause = error;

    expect(scrubError(error).message).toBe("<hidden>");
  });
});
