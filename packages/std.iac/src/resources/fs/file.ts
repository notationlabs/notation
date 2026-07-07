import { resource } from "@notation/resource";
import { getSourceSha256 } from "src/utils/hash";
import * as fs from "node:fs/promises";

export type FileSchema = {
  Key: { filePath: string };
  CreateParams: { filePath: string; sourceSha256: string };
  UpdateParams: { filePath: string; sourceSha256: string };
  ReadResult: { file: Buffer };
};

const fileResource = resource<FileSchema>({
  type: "std/fs/File",
});

export const fileSchema = fileResource.defineSchema({
  filePath: {
    propertyType: "param",
    presence: "required",
    primaryKey: true,
  },
  sourceSha256: {
    propertyType: "param",
    presence: "required",
  },
  file: {
    propertyType: "computed",
    presence: "required",
    hidden: true,
  },
} as const);

export const File = fileSchema.defineOperations({
  deriveParams: async ({ config }) => {
    const sourceSha256 = await getSourceSha256(config.filePath!);
    return { sourceSha256 };
  },
  read: async (config) => {
    const file = await fs.readFile(config.filePath);
    return { ...config, file };
  },
  create: async () => {},
  update: async () => {},
  delete: async () => {},
});

export type FileInstance = InstanceType<typeof File>;
