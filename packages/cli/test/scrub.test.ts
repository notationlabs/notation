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
  stream.write(Buffer.from("plain"));
  restore();
  stream.write("sk_live_123");

  expect(written.map(String)).toEqual([
    "error: <hidden> rejected\n",
    '{"value":"<hidden>"}',
    "plain",
    "sk_live_123",
  ]);
});

it("keeps a character whose bytes are split across two writes", () => {
  const written: Buffer[] = [];
  const stream = {
    write: (chunk: Buffer) => {
      written.push(chunk);
      return true;
    },
  };
  const restore = scrubOutput([stream as any]);
  const bytes = Buffer.from("café ✓");

  stream.write(bytes.subarray(0, 4));
  stream.write(bytes.subarray(4, 8));
  stream.write(bytes.subarray(8));
  restore();

  expect(Buffer.concat(written).toString("utf8")).toBe("café ✓");
});
