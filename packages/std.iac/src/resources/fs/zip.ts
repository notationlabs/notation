import { resource } from "@notation/resource";
import * as fs from "node:fs/promises";
import { zip } from "src/utils/zip";
import { getSourceSha256 } from "src/utils/hash";

export type ZipSchema = {
  Key: { sourceFilePath: string };
  CreateParams: {
    sourceFilePath: string;
    filePath: string;
    sourceSha256: string;
  };
  UpdateParams: {
    sourceFilePath: string;
    filePath: string;
    sourceSha256: string;
  };
  ReadResult: { file: Buffer };
};

const zipResource = resource<ZipSchema>({
  type: "std/fs/Zip",
});

export const zipSchema = zipResource.defineSchema({
  sourceFilePath: {
    propertyType: "param",
    presence: "required",
    primaryKey: true,
  },
  filePath: {
    propertyType: "param",
    presence: "required",
    secondaryKey: true,
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

export const Zip = zipSchema.defineOperations({
  deriveParams: async ({ config }) => {
    const sourceSha256 = await getSourceSha256(config.sourceFilePath!);
    const filePath = `${config.sourceFilePath}.zip`;
    return { sourceSha256, filePath };
  },
  read: async (params) => {
    try {
      const file = await fs.readFile(params.filePath);
      return { ...params, file };
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      await zip.package(params.sourceFilePath, params.filePath);
      const file = await fs.readFile(params.filePath);
      return { ...params, file };
    }
  },
  create: async (params) => {
    await zip.package(params.sourceFilePath, params.filePath);
  },
  update: async (config) => {
    await fs.unlink(config.filePath);
    await zip.package(config.sourceFilePath, config.filePath);
  },
  delete: async (config) => {
    await fs.unlink(config.filePath);
  },
});

export type ZipFileInstance = InstanceType<typeof Zip>;
