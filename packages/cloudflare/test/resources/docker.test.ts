import { afterEach, expect, it, vi } from "vitest";
import {
  DockerNotFoundError,
  runDocker,
} from "src/resources/containers/docker";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("throws DockerNotFoundError when the Docker CLI is not on PATH", async () => {
  vi.stubEnv("PATH", "/nonexistent");

  await expect(runDocker(["info"])).rejects.toBeInstanceOf(DockerNotFoundError);
});
