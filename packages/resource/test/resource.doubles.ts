import { resource } from "src";
import { boolean, number, string } from "./validators";

export type TestSchema = {
  Key: {
    primaryKey: string;
    optionalSecondaryKey: number;
  };
  CreateParams: {
    optionalSecondaryKey: number;
    requiredParam: string;
    hiddenParam: string;
    intrinsicParam: boolean;
  };
  UpdateParams: {
    optionalSecondaryKey: number;
    requiredParam: string;
    hiddenParam: string;
    intrinsicParam: boolean;
  };
  ReadResult: {
    primaryKey: string;
    optionalSecondaryKey: number;
    requiredParam: string;
    volatileComputed: string;
    intrinsicParam: boolean;
  };
};

export const testSchema = {
  primaryKey: {
    value: string(),
    presence: "required",
    propertyType: "computed",
    primaryKey: true,
  },
  optionalSecondaryKey: {
    value: number(),
    presence: "optional",
    propertyType: "param",
    secondaryKey: true,
    immutable: true,
  },
  requiredParam: {
    value: string(),
    presence: "required",
    propertyType: "param",
  },
  volatileComputed: {
    value: string(),
    presence: "required",
    propertyType: "computed",
    volatile: true,
  },
  hiddenParam: {
    value: string(),
    presence: "required",
    propertyType: "param",
    hidden: true,
  },
  intrinsicParam: {
    value: boolean(),
    presence: "required",
    propertyType: "param",
  },
} as const;

export const testOperations = {
  async create() {
    return testResourceOutput;
  },
  async delete() {},
  async update() {},
  async read() {
    return {
      primaryKey: "",
      optionalSecondaryKey: "",
      requiredParam: "",
    } as const;
  },
  deriveParams() {
    return { intrinsicParam: true };
  },
};

export const TestResourceSchema = resource<TestSchema>({
  type: "provider/service/resource",
  provider: "test",
}).defineSchema(testSchema);

export const TestResource = TestResourceSchema.defineOperations(testOperations);

export const TestResource2 = resource<TestSchema>({
  type: "provider/service/resource-2",
  provider: "test",
})
  .defineSchema(testSchema)
  .defineOperations(testOperations);

export const testResourceOutput = {
  primaryKey: "0",
  requiredParam: "name",
  hiddenParam: "",
  volatileComputed: "",
  intrinsicParam: true,
};

export const testResourceConfig = {
  requiredParam: "name1",
  hiddenParam: "",
};
