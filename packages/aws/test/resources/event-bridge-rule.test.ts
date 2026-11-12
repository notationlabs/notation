import { beforeEach, expect, test, vi } from "vitest";
import * as sdk from "@aws-sdk/client-eventbridge";
import { eventBridgeClient } from "src/resources/utils/aws-clients";
import {
  ResourceAlreadyExistsError,
  ResourceCreationUnknownError,
  validateValues,
} from "@notation/resource";
import { EventBridgeRule } from "src/resources/event-bridge/rule";
import { EventBus } from "src/resources/event-bridge/event-bus";

const send = vi.spyOn(eventBridgeClient(), "send");

const rule = new EventBridgeRule("rule", {
  config: {
    Name: "daily",
    EventBusName: "default",
    Targets: [{ Id: "fn", Arn: "arn:fn" }],
  },
  dependencies: { lambda: {} as any },
});

const key = { Name: "daily", EventBusName: "default" };

/** Answers the calls that create makes before PutTargets, for a rule that does not exist yet. */
function createCalls(command: any) {
  if (command instanceof sdk.DescribeRuleCommand) {
    throw new sdk.ResourceNotFoundException({
      message: "Rule daily does not exist",
      $metadata: {},
    });
  }
  if (command instanceof sdk.PutRuleCommand) return { RuleArn: "arn:rule" };
  return undefined;
}

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

test("a rule blocks the delete of a custom bus, and of no other type", () => {
  expect(EventBridgeRule.blocksDeleteOf).toEqual([EventBus.type]);
  expect(EventBus.blocksDeleteOf).toEqual([]);
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
  expect(() =>
    validateValues(rule, rule.toResult(result), "read"),
  ).not.toThrow();
});

function mockFailedEntries(
  failingCommand: new (...args: any[]) => unknown,
  existingTargetIds: string[] = [],
) {
  send.mockImplementation(async (command: any) => {
    const answer = createCalls(command);
    if (answer) return answer;
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

  await expect(rule.create!(params)).rejects.toThrow(failureMessage);
  expect(sentCommands().map((c) => c.constructor)).toEqual([
    sdk.DescribeRuleCommand,
    sdk.PutRuleCommand,
    sdk.PutTargetsCommand,
    sdk.ListTargetsByRuleCommand,
    sdk.DeleteRuleCommand,
  ]);
});

test("create leaves the targets out of PutRule", async () => {
  mockFailedEntries(class Never {});
  const params = { ...key, Targets: [{ Id: "fn", Arn: "arn:fn" }] };

  await rule.create!(params);

  const putRule = sentCommands().find((c) => c instanceof sdk.PutRuleCommand);
  expect(putRule!.input).toEqual(key);
});

test("create refuses a rule that exists, without changing it", async () => {
  send.mockImplementation(async (command: any) => {
    if (command instanceof sdk.DescribeRuleCommand) {
      return { Name: "daily", Arn: "arn:rule" };
    }
    return {};
  });
  const params = { ...key, Targets: [{ Id: "fn", Arn: "arn:fn" }] };

  await expect(rule.create!(params)).rejects.toSatisfy(
    ResourceAlreadyExistsError.is,
  );
  expect(sentCommands().map((c) => c.constructor)).toEqual([
    sdk.DescribeRuleCommand,
  ]);
});

test("create deletes the rule, removing the targets that were put, when another target could not be put", async () => {
  mockFailedEntries(sdk.PutTargetsCommand, ["fn"]);
  const params = {
    ...key,
    Targets: [
      { Id: "fn", Arn: "arn:fn" },
      { Id: "bad-fn", Arn: "arn:bad-fn" },
    ],
  };

  await expect(rule.create!(params)).rejects.toThrow(/the rule was deleted/);
  expect(sentCommands().map((c) => c.constructor)).toEqual([
    sdk.DescribeRuleCommand,
    sdk.PutRuleCommand,
    sdk.PutTargetsCommand,
    sdk.ListTargetsByRuleCommand,
    sdk.RemoveTargetsCommand,
    sdk.DeleteRuleCommand,
  ]);
});

test("create reports an unknown outcome, naming both failures, when the rule could not be deleted after its targets failed", async () => {
  send.mockImplementation(async (command: any) => {
    const answer = createCalls(command);
    if (answer) return answer;
    if (command instanceof sdk.PutTargetsCommand) {
      throw new Error("access denied to the target");
    }
    if (command instanceof sdk.ListTargetsByRuleCommand) return { Targets: [] };
    if (command instanceof sdk.DeleteRuleCommand) {
      throw new Error("access denied to the rule");
    }
    return {};
  });

  const created = rule.create!({
    ...key,
    Targets: [{ Id: "fn", Arn: "arn:fn" }],
  });
  await expect(created).rejects.toThrow(
    /access denied to the target.*could not be deleted: access denied to the rule/,
  );
  await expect(created).rejects.toSatisfy(ResourceCreationUnknownError.is);
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

  await expect(rule.create!(params)).resolves.toBeUndefined();
});

test("read returns the event pattern in compact form", async () => {
  send.mockImplementation(async (command: any) => {
    if (command instanceof sdk.ListTargetsByRuleCommand) return { Targets: [] };
    return {
      Name: "orders",
      Arn: "arn:rule",
      State: "DISABLED",
      EventPattern: '{\n  "source": ["shop"]\n}',
    };
  });

  const result = await rule.read!(key);

  expect(result).toMatchObject({
    EventPattern: '{"source":["shop"]}',
    State: "DISABLED",
  });
});

test("a pattern in config is sent in compact form", async () => {
  const pretty = new EventBridgeRule("pretty", {
    config: {
      ...key,
      EventPattern: '{\n  "source": ["shop"]\n}',
      Targets: [{ Id: "fn", Arn: "arn:fn" }],
    },
    dependencies: { lambda: {} as any },
  });

  expect((await pretty.getParams()).EventPattern).toBe('{"source":["shop"]}');
});

test("update sends the rule's state and event pattern to PutRule", async () => {
  mockExistingTargets(["fn"]);
  const params = {
    Name: "orders",
    EventBusName: "orders-bus",
    EventPattern: '{"source":["shop"]}',
    State: "DISABLED" as const,
    Targets: [{ Id: "fn", Arn: "arn:fn" }],
  };
  const busKey = { Name: "orders", EventBusName: "orders-bus" };

  await rule.update!(busKey, params, params, {} as any);

  expect(sentCommands()[0].input).toEqual({
    Name: "orders",
    EventBusName: "orders-bus",
    EventPattern: '{"source":["shop"]}',
    State: "DISABLED",
  });
});
