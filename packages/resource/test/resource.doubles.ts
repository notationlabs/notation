import { resource } from "src";
import { z } from "zod";

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
    presence: "required",
    propertyType: "computed",
    valueType: z.string(),
    primaryKey: true,
  },
  optionalSecondaryKey: {
    presence: "optional",
    propertyType: "param",
    valueType: z.number(),
    secondaryKey: true,
    immutable: true,
  },
  requiredParam: {
    presence: "required",
    propertyType: "param",
    valueType: z.string(),
  },
  volatileComputed: {
    presence: "required",
    propertyType: "computed",
    valueType: z.string(),
    volatile: true,
  },
  hiddenParam: {
    presence: "required",
    propertyType: "param",
    valueType: z.string(),
    hidden: true,
  },
  intrinsicParam: {
    presence: "required",
    propertyType: "param",
    valueType: z.boolean(),
  },
} as const;

export const testOperations = {
  async create() {
    return testResourceOutput;
  },
  async delete() {},
  async update() {},
  async read() {
    return { primaryKey: "", optionalSecondaryKey: "", requiredParam: "" };
  },
  deriveParams() {
    return { intrinsicParam: true };
  },
};

export const TestResourceSchema = resource<TestSchema>({
  type: "provider/service/resource",
}).defineSchema(testSchema);

export const TestResource = TestResourceSchema.defineOperations(testOperations);

export const TestResource2 = resource<TestSchema>({
  type: "provider/service/resource-2",
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
