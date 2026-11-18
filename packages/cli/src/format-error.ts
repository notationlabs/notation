import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

// Formats an error as its name and message, followed by the stack frames
// whose file is in the project at `root` and outside node_modules. Each error
// in an AggregateError follows, indented, and each cause follows on a line
// that starts with "Caused by:".
export function formatError(error: unknown, root: string): string {
  return errorLines(error, root, new Set()).join("\n");
}

function errorLines(
  error: unknown,
  root: string,
  seen: Set<unknown>,
): string[] {
  if (!(error instanceof Error)) return [inspect(error)];
  if (seen.has(error)) return [];
  seen.add(error);
  const lines = [
    error.message ? `${error.name}: ${error.message}` : error.name,
  ];
  if (typeof error.stack === "string") {
    for (const line of error.stack.split("\n")) {
      const file = framePath(line);
      if (file !== undefined && isProjectFile(file, root)) lines.push(line);
    }
  }
  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    for (const inner of error.errors) {
      lines.push(...errorLines(inner, root, seen).map((line) => `  ${line}`));
    }
  }
  if (error.cause !== undefined) {
    const cause = errorLines(error.cause, root, seen);
    if (cause.length > 0) {
      cause[0] = `Caused by: ${cause[0]}`;
      lines.push(...cause);
    }
  }
  return lines;
}

// Reads the file from a V8 frame, in either of its two forms:
//   at fn (/path/to/file.ts:1:2)
//   at /path/to/file.ts:1:2
// The path may contain spaces. Frames without a file location, such as
// `at Promise.all (index 0)` and `node:internal` frames, give undefined.
function framePath(line: string): string | undefined {
  const match = line.match(/^\s+at (?:.*? \()?(.+?):\d+:\d+\)?$/);
  const file = match?.[1];
  if (!file) return undefined;
  if (file.startsWith("file:")) {
    try {
      return fileURLToPath(file);
    } catch {
      return undefined;
    }
  }
  return path.isAbsolute(file) ? file : undefined;
}

function isProjectFile(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return false;
  }
  return !relative.split(path.sep).includes("node_modules");
}
