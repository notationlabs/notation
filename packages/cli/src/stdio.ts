import {
  createNdjsonEventEmitter,
  scrubError,
  scrubSecrets,
  type ReconcilerEventEmitter,
} from "@notation/core";

function scrubChunk(
  chunk: string | Uint8Array,
  encoding?: BufferEncoding,
): string | Uint8Array {
  if (typeof chunk === "string") {
    return scrubSecrets(chunk);
  }
  const text = Buffer.from(chunk).toString(encoding ?? "utf8");
  const scrubbed = scrubSecrets(text);
  return scrubbed === text ? chunk : Buffer.from(scrubbed, encoding ?? "utf8");
}

export function redirectStdoutToStderr() {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const write = (line: string): void => {
    originalWrite(line);
  };
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ) => {
    const encoding =
      typeof encodingOrCb === "string" ? encodingOrCb : undefined;
    const scrubbed = scrubChunk(chunk, encoding);
    return (process.stderr.write as any)(scrubbed, encodingOrCb, cb);
  }) as typeof process.stdout.write;
  return {
    write,
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}

export function createScrubbedNdjsonEmitter(
  write: (line: string) => void | Promise<void>,
): ReconcilerEventEmitter {
  const emit = createNdjsonEventEmitter(write);
  return (event) =>
    emit(scrubError(event) as Parameters<ReconcilerEventEmitter>[0]);
}
