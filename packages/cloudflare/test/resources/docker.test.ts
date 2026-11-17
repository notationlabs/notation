import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerCommandError,
  DockerNotFoundError,
  OutputTail,
  runDocker,
} from "src/resources/containers/docker";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("throws DockerNotFoundError when the Docker CLI is not on PATH", async () => {
  vi.stubEnv("PATH", "/nonexistent");

  await expect(runDocker(["info"])).rejects.toBeInstanceOf(DockerNotFoundError);
});

// The fake Docker CLI is a shell script.
it.skipIf(process.platform === "win32")(
  "puts the end of stderr after the end of stdout, without progress lines",
  async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "fake-docker-"));
    try {
      writeFileSync(
        path.join(bin, "docker"),
        [
          "#!/bin/sh",
          "echo '076cba098ace: Waiting'",
          "echo 'net/http: timeout' >&2",
          "echo '076cba098ace: Pushed'",
          "echo 'The push refers to repository'",
          "exit 1",
        ].join("\n"),
      );
      chmodSync(path.join(bin, "docker"), 0o755);
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);

      const error = await runDocker(["push", "x"]).catch((e) => e);

      expect(error).toBeInstanceOf(DockerCommandError);
      expect(error.output).toBe(
        "The push refers to repository\nnet/http: timeout",
      );
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  },
);

it("prints the output of a failed command once when inspected", () => {
  const error = new DockerCommandError(["push"], 1, "net/http: timeout");

  expect(error.output).toBe("net/http: timeout");
  expect(inspect(error).split("net/http: timeout")).toHaveLength(2);
});

describe("OutputTail", () => {
  it("drops layer progress lines", () => {
    const tail = new OutputTail();

    tail.append("The push refers to repository [registry.cloudflare.com/x]\n");
    tail.append("076cba098ace: Preparing\n076cba098ace: Waiting\n");
    tail.append("076cba098ace: Pushing [==>   ]  1.2MB/30MB\n");
    tail.append("076cba098ace: Pushed\n0c4023204e5b: Layer already exists\n");
    tail.append("aa4e89108622: Mounted from other/repo\n");
    tail.append("failed commit on ref: net/http: timeout\n");

    expect(tail.end()).toBe(
      "The push refers to repository [registry.cloudflare.com/x]\nfailed commit on ref: net/http: timeout",
    );
  });

  it("joins a line split across chunks, and keeps a last line with no line break", () => {
    const tail = new OutputTail();

    tail.append("076cba098ace: Wai");
    tail.append("ting\nfailed to ");
    tail.append("push");

    expect(tail.end()).toBe("failed to push");
  });

  it("splits lines on carriage returns", () => {
    const tail = new OutputTail();

    tail.append("076cba098ace: Waiting\rfirst\r\nsecond\r");
    tail.append("\nthird");

    expect(tail.end()).toBe("first\nsecond\nthird");
  });

  it("keeps the last 4000 characters of a line longer than that", () => {
    const tail = new OutputTail();

    tail.append("a".repeat(5_000) + "\n");
    tail.append("b".repeat(10_000));

    const output = tail.end();
    expect(output).toBe("b".repeat(4_000));
  });

  it("keeps the last 4000 characters, from the start of a line", () => {
    const tail = new OutputTail();
    const line = "x".repeat(99);

    for (let i = 0; i < 100; i++) tail.append(`${i} ${line}\n`);

    const output = tail.end();
    expect(output.length).toBeLessThanOrEqual(4_000);
    expect(output.startsWith("62 ")).toBe(true);
    expect(output.endsWith(`99 ${line}`)).toBe(true);
  });
});
