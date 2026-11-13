import { scrubSecretValues } from "@notation/core";

type Stream = Pick<NodeJS.WriteStream, "write">;

/**
 * Removes the secret values that the process has read from everything it
 * writes to `streams`, which covers log lines, events, plan output and
 * error messages. Returns a function that undoes it.
 */
export function scrubOutput(
  streams: Stream[] = [process.stdout, process.stderr],
): () => void {
  const restores = streams.map((stream) => {
    const write = stream.write;
    stream.write = function (this: Stream, chunk: unknown, ...rest: unknown[]) {
      return (write as (...args: unknown[]) => boolean).call(
        this,
        scrubChunk(chunk),
        ...rest,
      );
    } as Stream["write"];
    return () => {
      stream.write = write;
    };
  });
  return () => {
    for (const restore of restores) restore();
  };
}

function scrubChunk(chunk: unknown): unknown {
  if (typeof chunk === "string") return scrubSecretValues(chunk);
  if (!(chunk instanceof Uint8Array)) return chunk;
  const text = Buffer.from(chunk).toString("utf8");
  const scrubbed = scrubSecretValues(text);
  return scrubbed === text ? chunk : scrubbed;
}
