import { describe, expect, expectTypeOf, it } from "vitest";
import {
  OutputRefStringError,
  isOwnPhysicalName,
  ownPhysicalName,
  resource,
  isStateRefTarget,
} from "src";
import { object, string } from "./validators";

type Statement = { Resource: string };

const Worker = resource<{
  Key: { Name: string };
  CreateParams: {
    Name: string;
    Path: string;
    Label?: string;
    Sources?: string[];
    Bindings?: Statement[];
  };
  UpdateParams: { Label?: string; Sources?: string[]; Bindings?: Statement[] };
  ReadResult: { Id: string; Etag: string };
}>({ type: "test/refs/worker", provider: "test" })
  .defineSchema({
    Name: {
      propertyType: "param",
      value: string(),
      presence: "required",
      secondaryKey: true,
      immutable: true,
      physicalName: { maxLength: 64 },
    },
    Path: {
      propertyType: "param",
      value: string(),
      presence: "required",
      immutable: true,
    },
    Label: { propertyType: "param", value: string(), presence: "optional" },
    Sources: {
      propertyType: "param",
      value: object<string[]>(),
      presence: "optional",
      collect: (items: any[]) => items.flat(),
    },
    Bindings: {
      propertyType: "param",
      value: object<Statement[]>(),
      presence: "optional",
      collect: (items: any[]) => items.flat(),
    },
    Id: {
      propertyType: "computed",
      value: string(),
      presence: "required",
      primaryKey: true,
    },
    Etag: { propertyType: "computed", value: string(), presence: "required" },
  })
  .defineOperations({
    create: async () => ({ Id: "1", Etag: "1" }),
    update: async () => undefined,
    delete: async () => undefined,
  });

describe("~state refs", () => {
  it("is typed as an output that may be missing", () => {
    const binder = new Worker("binder", { config: { Path: "/" } });
    expectTypeOf(binder["~state"].outputRef("Name")).toEqualTypeOf<
      string | undefined
    >();
  });

  it("reads a param that only a replace changes, and marks its target", () => {
    const binder = new Worker("binder", { config: { Path: "/" } });
    expect(isStateRefTarget(binder)).toBe(false);
    binder["~state"].outputRef("Name");
    binder["~state"].outputRef("Path");
    expect(isStateRefTarget(binder)).toBe(true);
  });

  it("throws for an output that an update can change", () => {
    const binder = new Worker("binder", { config: { Path: "/" } });
    expect(() => binder["~state"].outputRef("Label")).toThrow(
      "Cannot read Label of binder from state: ~state can read only an output that only a replace changes, which is a param that is immutable, primaryKey or secondaryKey, or that has physicalName",
    );
    expect(() => binder["~state"].outputRef("Etag")).toThrow(
      "Cannot read Etag of binder from state",
    );
    expect(() => binder["~state"].outputRef("Id")).toThrow(
      "Cannot read Id of binder from state",
    );
  });

  it("adds no dependency, and resolves from the recorded outputs, to undefined for one with no record", async () => {
    const host = new Worker("host", { config: { Path: "/" } });
    const binder = new Worker("binder", { config: { Path: "/" } });
    const absent = new Worker("absent", { config: { Path: "/" } });
    host.contribute({
      Sources: [
        binder["~state"].outputRef("Name")!,
        absent["~state"].outputRef("Name")!,
      ],
    });

    expect(host.getDependencies()).toEqual([]);
    const recordedOutputs = { binder: { Name: "binder-1" }, absent: null };
    expect(await host.getParams({ recordedOutputs })).toMatchObject({
      Sources: ["binder-1", undefined],
    });
    expect(await host.planParams({ recordedOutputs })).toMatchObject({
      Sources: ["binder-1", undefined],
    });
  });

  it("throws when config holds one", () => {
    const binder = new Worker("binder", { config: { Path: "/" } });
    const host = new Worker("host", {
      config: { Path: "/", Sources: [binder["~state"].outputRef("Name")!] },
    });

    expect(() => host.getDependencies()).toThrow(
      "The config of host holds a ~state ref to binder. A ~state ref can only be placed in a contribution.",
    );
  });

  it("throws when the outputs in state were not read for the target", async () => {
    const host = new Worker("host", { config: { Path: "/" } });
    const binder = new Worker("binder", { config: { Path: "/" } });
    host.contribute({ Sources: [binder["~state"].outputRef("Name")!] });

    await expect(host.getParams({ recordedOutputs: {} })).rejects.toThrow(
      "Output binder.Name is read from state, but the outputs in state were not read for binder.",
    );
  });

  it("can't be turned into a string", () => {
    const binder = new Worker("binder", { config: { Path: "/" } });
    expect(() => `${binder["~state"].outputRef("Name")}`).toThrow(
      OutputRefStringError,
    );
  });
});

describe("a ref to the resource's own physicalName param", () => {
  it("adds no dependency, and stands in the params until the name is filled in", async () => {
    const worker = new Worker("worker", { config: { Path: "/" } });
    worker.contribute({ Bindings: [{ Resource: worker.outputRef("Name") }] });

    expect(worker.getDependencies()).toEqual([]);
    const params = (await worker.getParams()) as { Bindings: Statement[] };
    expect(params.Bindings).toEqual([{ Resource: ownPhysicalName("Name") }]);
    expect(isOwnPhysicalName(params.Bindings[0]!.Resource)).toBe(true);
  });

  it("is a dependency when it names another output of the resource", () => {
    const worker = new Worker("worker", { config: { Path: "/" } });
    worker.contribute({ Bindings: [{ Resource: worker.outputRef("Id") }] });

    expect(worker.getDependencies()).toEqual([worker]);
  });
});
