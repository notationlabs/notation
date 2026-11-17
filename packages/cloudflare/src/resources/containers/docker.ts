import { spawn } from "node:child_process";

const OUTPUT_TAIL = 4_000;

/** The Docker CLI ran but exited with a code other than 0. */
export class DockerCommandError extends Error {
  /** The end of the command's stdout, then the end of its stderr. */
  declare readonly output: string;

  constructor(
    args: readonly string[],
    exitCode: number | null,
    output: string,
  ) {
    super(
      `docker ${args[0]} exited with code ${exitCode}${output ? `:\n${output}` : ""}`,
    );
    this.name = "DockerCommandError";
    // Not enumerable, because the message already holds the output, and an
    // inspected error would print it a second time.
    Object.defineProperty(this, "output", { value: output });
  }
}

/** The Docker CLI is not installed, or is not on `PATH`. */
export class DockerNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Building a container image needs the Docker CLI, which was not found on PATH. Install Docker, such as Docker Desktop, OrbStack or Colima, and deploy again.",
      options,
    );
    this.name = "DockerNotFoundError";
  }
}

/**
 * Runs the Docker CLI with `args`. Writes `stdin` to the process's standard
 * input, if it is given. Throws `DockerCommandError` with the end of stdout,
 * then the end of stderr, when the CLI exits with a code other than 0. Each
 * end is at most `OUTPUT_TAIL` characters.
 */
export async function runDocker(
  args: string[],
  options: { stdin?: string } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = new OutputTail();
    const stderr = new OutputTail();
    // Decoded by the stream, so that a character split across two chunks
    // stays whole.
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => stdout.append(chunk));
    child.stderr!.on("data", (chunk: string) => stderr.append(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new DockerNotFoundError({ cause: error })
          : error,
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const output = [stdout.end(), stderr.end()].filter(Boolean).join("\n");
        reject(new DockerCommandError(args, code, output));
      }
    });
    if (child.stdin) {
      // Docker may exit before it reads stdin. The EPIPE would otherwise be
      // uncaught, and the exit code already reports the failure.
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    }
  });
}

// A line of `docker push` or `docker pull` that reports the progress of one
// layer, such as `076cba098ace: Waiting`.
const LAYER_PROGRESS =
  /^[0-9a-f]{12}: (Preparing|Waiting|Pushing|Pushed|Pulling fs layer|Downloading|Download complete|Extracting|Pull complete|Verifying Checksum|Layer already exists|Already exists|Mounted from )/;

/**
 * Keeps the last `OUTPUT_TAIL` characters of a stream, without layer
 * progress lines. The tail starts at the start of a line, unless its last
 * line alone is longer than `OUTPUT_TAIL`.
 */
export class OutputTail {
  #lines: string[] = [];
  #length = 0;
  #partial = "";

  append(chunk: string): void {
    const lines = (this.#partial + chunk).split(/\r?\n|\r/);
    this.#partial = lines.pop()!.slice(-OUTPUT_TAIL);
    for (const line of lines) this.#push(line);
  }

  // Returns the tail, including a last line that has no line break.
  end(): string {
    if (this.#partial) this.#push(this.#partial);
    this.#partial = "";
    return this.#lines.join("\n");
  }

  #push(line: string): void {
    if (line.trim() === "" || LAYER_PROGRESS.test(line)) return;
    line = line.slice(-OUTPUT_TAIL);
    this.#lines.push(line);
    this.#length += line.length + 1;
    while (this.#lines.length > 1 && this.#length > OUTPUT_TAIL) {
      this.#length -= this.#lines.shift()!.length + 1;
    }
  }
}
