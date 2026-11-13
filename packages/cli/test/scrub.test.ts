import { expect, it } from "vitest";
import { recordSecretValue } from "@notation/core";
import { scrubOutput } from "../src/scrub";

it("removes recorded secret values from what is written to the streams", () => {
  const written: unknown[] = [];
  const stream = {
    write: (chunk: unknown) => {
      written.push(chunk);
      return true;
    },
  };
  const restore = scrubOutput([stream as any]);
  recordSecretValue("sk_live_123");

  stream.write("error: sk_live_123 rejected\n");
  stream.write(Buffer.from(`{"value":"${btoa("sk_live_123")}"}`));
  const untouched = Buffer.from("plain");
  stream.write(untouched);
  restore();
  stream.write("sk_live_123");

  expect(written).toEqual([
    "error: <hidden> rejected\n",
    '{"value":"<hidden>"}',
    untouched,
    "sk_live_123",
  ]);
});
