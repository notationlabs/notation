export function redirectStdoutToStderr() {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const write = (line: string): void => {
    originalWrite(line);
  };
  process.stdout.write = ((chunk: any, ...args: any[]) =>
    (process.stderr.write as any)(
      chunk,
      ...args,
    )) as typeof process.stdout.write;
  return {
    write,
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}
