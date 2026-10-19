import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { deployInChild } from "../src/deploy-child";

function fakeSpawn(lines: string[], exitCode: number) {
  const calls: string[][] = [];
  const children: { kill: ReturnType<typeof vi.fn> }[] = [];
  const spawn = ((_cmd: string, args: string[]) => {
    calls.push(args);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.kill = vi.fn();
    children.push(child);
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${line}\n`);
      child.stdout.end();
      child.stdout.once("close", () => child.emit("close", exitCode));
    });
    return child;
  }) as any;
  return { spawn, calls, children };
}

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("deployInChild", () => {
  it("deploys the existing build in a child CLI process", async () => {
    const { spawn, calls } = fakeSpawn([], 0);

    await deployInChild({
      entryPoint: "infra/app.ts",
      executionId: "exec-1",
      logger: logger(),
      spawn,
    });

    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "deploy",
        "infra/app.ts",
        "--json",
        "--no-compile",
        "--no-drift-detection",
        "--execution-id",
        "exec-1",
      ]),
    );
  });

  it("relays the child's events to the logger without the wire version", async () => {
    const log = logger();
    const event = {
      level: "warn",
      event: "reconciler.drift.detected",
      resourceId: "docs",
    };
    const { spawn } = fakeSpawn([JSON.stringify({ version: 1, ...event })], 0);

    await deployInChild({
      entryPoint: "infra/app.ts",
      executionId: "exec-1",
      logger: log,
      spawn,
    });

    expect(log.warn).toHaveBeenCalledWith("reconciler.drift.detected", event);
  });

  it("rejects when the child exits with an error", async () => {
    const { spawn } = fakeSpawn([], 1);

    await expect(
      deployInChild({
        entryPoint: "infra/app.ts",
        executionId: "exec-1",
        logger: logger(),
        spawn,
      }),
    ).rejects.toThrow("Deploy exited with code 1");
  });

  it("passes a signal on to the child, then re-raises it", async () => {
    const { spawn, children } = fakeSpawn([], 0);
    const proc = Object.assign(new EventEmitter(), { pid: 42, kill: vi.fn() });

    const deploying = deployInChild({
      entryPoint: "infra/app.ts",
      executionId: "exec-1",
      logger: logger(),
      spawn,
      proc: proc as any,
    });
    proc.emit("SIGTERM", "SIGTERM");
    await deploying;

    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(proc.kill).toHaveBeenCalledWith(42, "SIGTERM");
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops listening for signals once the child exits", async () => {
    const { spawn } = fakeSpawn([], 0);
    const proc = Object.assign(new EventEmitter(), { pid: 42, kill: vi.fn() });

    await deployInChild({
      entryPoint: "infra/app.ts",
      executionId: "exec-1",
      logger: logger(),
      spawn,
      proc: proc as any,
    });

    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  });
});
