import { describe, expect, it, vi } from "vitest";
import {
  OutputRefStringError,
  UNKNOWN_AFTER_APPLY,
  collectResourceGraph,
  deferredOutputRef,
  mergeContributions,
  onEvaluationEnd,
  resource,
  text,
  type BaseResource,
} from "src";
import { object, string } from "./validators";

type Environment = { Variables: Record<string, string> };

const Queue = resource<{
  Key: { QueueUrl: string };
  CreateParams: { QueueName: string };
  UpdateParams: {};
  ReadResult: { QueueUrl: string };
}>({ type: "test/deferred/queue", provider: "test" })
  .defineSchema({
    QueueUrl: {
      propertyType: "computed",
      value: string(),
      presence: "required",
      primaryKey: true,
    },
    QueueName: {
      propertyType: "param",
      presence: "required",
      value: string(),
      immutable: true,
    },
  })
  .defineOperations({
    create: async () => ({ QueueUrl: "url" }),
    delete: async () => undefined,
  });

const Fn = resource<{
  Key: { FunctionName: string };
  CreateParams: {
    FunctionName: string;
    Url: string;
    Environment?: Environment;
  };
  UpdateParams: { Url: string; Environment?: Environment };
  ReadResult: {};
}>({ type: "test/deferred/function", provider: "test" })
  .defineSchema({
    FunctionName: {
      propertyType: "param",
      value: string(),
      presence: "required",
      primaryKey: true,
      immutable: true,
    },
    Url: { propertyType: "param", presence: "required", value: string() },
    Environment: {
      propertyType: "param",
      value: object<Environment>(),
      presence: "optional",
      collect: mergeContributions,
    },
  })
  .defineOperations({
    create: async () => undefined,
    update: async () => undefined,
    delete: async () => undefined,
  });

// A ref to the URL of a queue that is declared when evaluation ends, as a
// group that waits for every module declares its resources.
function lateQueue() {
  let queue: InstanceType<typeof Queue> | undefined;
  const resolve = vi.fn((): BaseResource => queue!);
  const url = deferredOutputRef<string>({
    resourceId: "orders",
    path: ["QueueUrl"],
    resolve,
  });
  onEvaluationEnd(() => {
    queue = new Queue("orders", { config: { QueueName: "orders" } });
  });
  return { url, resolve, queue: () => queue! };
}

describe("deferredOutputRef", () => {
  it("finds its resource on the first read once evaluation has ended, and keeps it", async () => {
    let late!: ReturnType<typeof lateQueue>;
    let fn!: InstanceType<typeof Fn>;
    await collectResourceGraph(() => {
      late = lateQueue();
      fn = new Fn("fn", {
        config: { FunctionName: "fn", Url: text`${late.url}/callback` },
      });
    });

    expect(late.resolve).not.toHaveBeenCalled();
    expect(fn.getDependencies()).toEqual([late.queue()]);
    expect(late.url.resource).toBe(late.queue());
    expect(late.resolve).toHaveBeenCalledTimes(1);
  });

  it("plans as unknown before its resource is deployed, and is filled in at deploy", async () => {
    let late!: ReturnType<typeof lateQueue>;
    let fn!: InstanceType<typeof Fn>;
    await collectResourceGraph(() => {
      late = lateQueue();
      fn = new Fn("fn", { config: { FunctionName: "fn", Url: late.url } });
      fn.contribute({
        Environment: { Variables: { QUEUE: late.url, MODE: "fast" } },
      });
    });

    expect(await fn.planParams()).toMatchObject({
      Url: UNKNOWN_AFTER_APPLY,
      Environment: { Variables: { QUEUE: UNKNOWN_AFTER_APPLY, MODE: "fast" } },
    });
    late.queue().setOutput({ QueueUrl: "https://sqs/orders" } as any);
    expect(await fn.getParams()).toMatchObject({
      Url: "https://sqs/orders",
      Environment: { Variables: { QUEUE: "https://sqs/orders" } },
    });
  });

  it("throws, naming the ref, when its resource is read while the modules load", async () => {
    await collectResourceGraph(() => {
      const { url, resolve } = lateQueue();
      expect(() => url.resource).toThrow(
        /Output orders\.QueueUrl was read while the infra modules load/,
      );
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  it("names the ref when it is turned into a string while the modules load, without finding its resource", async () => {
    await collectResourceGraph(() => {
      const { url, resolve } = lateQueue();
      expect(() => `${url}`).toThrow(OutputRefStringError);
      expect(() => `${url}`).toThrow(/^Output orders\.QueueUrl:/);
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  it("is written in canonical form and sorted without finding its resource", async () => {
    let late!: ReturnType<typeof lateQueue>;
    await collectResourceGraph(() => {
      late = lateQueue();
      const fn = new Fn("fn", {
        config: { FunctionName: "fn", Url: "https://x" },
      });
      fn.contribute({ Environment: { Variables: { A: late.url } } });
      fn.contribute({ Environment: { Variables: { B: "b" } } });
      const joined = text`${late.url}/x`;
      expect(joined["~describe"]()).toBe("<output orders.QueueUrl>/x");
    });
    expect(late.resolve).not.toHaveBeenCalled();
  });

  it("finds its resource when it is made outside a resource graph", () => {
    const queue = new Queue("orders", { config: { QueueName: "orders" } });
    const url = deferredOutputRef<string>({
      resourceId: "orders",
      path: ["QueueUrl"],
      resolve: () => queue,
    });
    expect(url.resource).toBe(queue);
  });

  it.each([
    ["no resource", () => undefined],
    [
      "resource other",
      () => new Queue("other", { config: { QueueName: "other" } }),
    ],
  ])(
    "throws, naming both, when resolve returns %s instead of the resource with its id",
    (found, make) => {
      const url = deferredOutputRef<string>({
        resourceId: "orders",
        path: ["QueueUrl"],
        resolve: make as () => BaseResource,
      });
      expect(() => url.resource).toThrow(
        `Output orders.QueueUrl resolved to ${found}, not to resource orders.`,
      );
    },
  );
});
