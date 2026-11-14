import { spawn } from "node:child_process";

const OUTPUT_TAIL = 4_000;

/** The Docker CLI ran but exited with a code other than 0. */
export class DockerCommandError extends Error {
  constructor(
    args: readonly string[],
    exitCode: number | null,
    /** The end of the command's combined stdout and stderr. */
    readonly output: string,
  ) {
    super(
      `docker ${args[0]} exited with code ${exitCode}${output ? `:\n${output}` : ""}`,
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
 * Runs the Docker CLI with `args`. Writes `stdin` to the process's standard
 * input, if it is given. Throws `DockerCommandError` with the end of stdout
 * and stderr when the CLI exits with a code other than 0.
 */
export async function runDocker(
  args: string[],
  options: { stdin?: string } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output = (output + chunk).slice(-OUTPUT_TAIL);
    };
    child.stdout!.on("data", append);
    child.stderr!.on("data", append);
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new DockerNotFoundError({ cause: error })
          : error,
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new DockerCommandError(args, code, output));
    });
    if (child.stdin) {
      // Docker may exit before it reads stdin. The EPIPE would otherwise be
      // uncaught, and the exit code already reports the failure.
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    }
  });
}
