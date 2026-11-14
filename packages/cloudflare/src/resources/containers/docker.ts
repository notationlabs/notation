import { spawn } from "node:child_process";

// The end of the output that an error shows.
const OUTPUT_TAIL_BYTES = 4_000;

/** The Docker CLI ran but exited with a code other than 0. */
export class DockerCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly output: string,
  ) {
    super(
      `docker ${args[0]} exited with code ${exitCode}${output ? `:\n${output.slice(-OUTPUT_TAIL_BYTES)}` : ""}`,
    );
    this.name = "DockerCommandError";
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
 * Runs the Docker CLI with `args`, and returns its stdout. Writes `stdin` to
 * the process's standard input, if it is given. Throws `DockerCommandError`
 * with stdout and stderr when the CLI exits with a code other than 0.
 */
export async function runDocker(
  args: string[],
  options: { stdin?: string } = {},
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new DockerNotFoundError({ cause: error })
          : error,
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new DockerCommandError(args, code, output));
    });
    child.stdin.end(options.stdin);
  });
}
