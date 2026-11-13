import { StringDecoder } from "node:string_decoder";
import { scrubSecretValues } from "@notation/core";

type Stream = Pick<NodeJS.WriteStream, "write">;

/**
 * Removes the secret values that the process has read from everything it
 * writes to `streams`, which covers log lines, events, plan output and
 * error messages. Returns a function that undoes it.
 *
 * Each write is scrubbed on its own, so a value split across two writes
 * isn't removed.
 */
export function scrubOutput(
  streams: Stream[] = [process.stdout, process.stderr],
): () => void {
  const restores = streams.map((stream) => {
    const write = stream.write;
    // Holds the bytes of a character that a chunk splits, until the next
    // chunk completes it.
    const decoder = new StringDecoder("utf8");
    stream.write = function (this: Stream, chunk: unknown, ...rest: unknown[]) {
      return (write as (...args: unknown[]) => boolean).call(
        this,
        scrubChunk(chunk, decoder),
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

function scrubChunk(chunk: unknown, decoder: StringDecoder): unknown {
  if (typeof chunk === "string") return scrubSecretValues(chunk);
  if (!(chunk instanceof Uint8Array)) return chunk;
  return Buffer.from(scrubSecretValues(decoder.write(Buffer.from(chunk))));
}
