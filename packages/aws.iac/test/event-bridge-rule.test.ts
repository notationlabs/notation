import { beforeEach, expect, test, vi } from "vitest";
import * as sdk from "@aws-sdk/client-eventbridge";
import { eventBridgeClient } from "src/utils/aws-clients";
import { EventBridgeRule } from "src/resources/event-bridge/rule";

const send = vi.spyOn(eventBridgeClient, "send");

const rule = new EventBridgeRule("rule", {
  config: { Name: "daily", EventBusName: "default" },
  dependencies: { lambda: {} as any },
});

const key = { Name: "daily", EventBusName: "default" };

function mockExistingTargets(ids: string[]) {
  send.mockImplementation(async (command: any) => {
    if (command instanceof sdk.ListTargetsByRuleCommand) {
      return { Targets: ids.map((Id) => ({ Id, Arn: `arn:${Id}` })) };
    }
    return {};
  });
}

function sentCommands() {
  return send.mock.calls.map(([command]) => command as any);
}

beforeEach(() => {
  send.mockReset();
});

test("update removes targets that are no longer configured", async () => {
  mockExistingTargets(["old-fn", "kept-fn"]);
  const params = {
    ...key,
    ScheduleExpression: "rate(1 day)",
    Targets: [
      { Id: "kept-fn", Arn: "arn:kept-fn" },
      { Id: "new-fn", Arn: "arn:new-fn" },
    ],
  };

  await rule.update!(key, params, params, {} as any);

  const commands = sentCommands();
  expect(commands.map((c) => c.constructor)).toEqual([
    sdk.PutRuleCommand,
    sdk.ListTargetsByRuleCommand,
    sdk.RemoveTargetsCommand,
    sdk.PutTargetsCommand,
  ]);
  expect(commands[0].input).toEqual({
    Name: "daily",
    EventBusName: "default",
    ScheduleExpression: "rate(1 day)",
  });
  expect(commands[2].input).toEqual({
    Rule: "daily",
    EventBusName: "default",
    Ids: ["old-fn"],
  });
  expect(commands[3].input).toEqual({
    Rule: "daily",
    EventBusName: "default",
    Targets: params.Targets,
  });
});

test("update does not remove targets when none are stale", async () => {
  mockExistingTargets(["fn"]);
  const params = { ...key, Targets: [{ Id: "fn", Arn: "arn:fn-v2" }] };

  await rule.update!(key, params, params, {} as any);

  expect(sentCommands().map((c) => c.constructor)).toEqual([
    sdk.PutRuleCommand,
    sdk.ListTargetsByRuleCommand,
    sdk.PutTargetsCommand,
  ]);
});

test("read reports the rule's current targets", async () => {
  send.mockImplementation(async (command: any) => {
    if (command instanceof sdk.ListTargetsByRuleCommand) {
      return { Targets: [{ Id: "fn", Arn: "arn:fn" }] };
    }
    return { Name: "daily", Arn: "arn:rule" };
  });

  const result = await rule.read!(key);

  expect(result).toMatchObject({ Targets: [{ Id: "fn", Arn: "arn:fn" }] });
});

function mockFailedEntries(
  failingCommand: new (...args: any[]) => unknown,
  existingTargetIds: string[] = [],
) {
  send.mockImplementation(async (command: any) => {
    if (command instanceof sdk.ListTargetsByRuleCommand) {
      return {
        Targets: existingTargetIds.map((Id) => ({ Id, Arn: `arn:${Id}` })),
      };
    }
    if (command instanceof failingCommand) {
      return {
        FailedEntryCount: 1,
        FailedEntries: [
          {
            TargetId: "bad-fn",
            ErrorCode: "ConcurrentModificationException",
            ErrorMessage: "Rule is being modified",
          },
        ],
      };
    }
    return { FailedEntryCount: 0, FailedEntries: [] };
  });
}

const failureMessage =
  /bad-fn: ConcurrentModificationException - Rule is being modified/;

test("create fails when a target could not be put", async () => {
  mockFailedEntries(sdk.PutTargetsCommand);
  const params = { ...key, Targets: [{ Id: "bad-fn", Arn: "arn:bad-fn" }] };

  await expect(rule.create!(params, {} as any)).rejects.toThrow(failureMessage);
});

test("update fails when a stale target could not be removed", async () => {
  mockFailedEntries(sdk.RemoveTargetsCommand, ["bad-fn"]);
  const params = { ...key, Targets: [{ Id: "fn", Arn: "arn:fn" }] };

  await expect(rule.update!(key, params, params, {} as any)).rejects.toThrow(
    failureMessage,
  );
  expect(sentCommands().map((c) => c.constructor)).not.toContain(
    sdk.PutTargetsCommand,
  );
});

test("update fails when a target could not be put", async () => {
  mockFailedEntries(sdk.PutTargetsCommand, ["fn"]);
  const params = { ...key, Targets: [{ Id: "bad-fn", Arn: "arn:bad-fn" }] };

  await expect(rule.update!(key, params, params, {} as any)).rejects.toThrow(
    failureMessage,
  );
});

test("delete fails and keeps the rule when a target could not be removed", async () => {
  mockFailedEntries(sdk.RemoveTargetsCommand, ["bad-fn"]);

  await expect(rule.delete!(key, {} as any)).rejects.toThrow(failureMessage);
  expect(sentCommands().map((c) => c.constructor)).not.toContain(
    sdk.DeleteRuleCommand,
  );
});

test("create succeeds when no targets failed", async () => {
  mockFailedEntries(class Never {});
  const params = { ...key, Targets: [{ Id: "fn", Arn: "arn:fn" }] };

  await expect(rule.create!(params, {} as any)).resolves.toBeUndefined();
});
