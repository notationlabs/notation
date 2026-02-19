import { resource } from "@notation/resource";
import * as z from "zod";
import { zip } from "src/utils/zip";

export type ZipSchema = {
  Key: { filePath: string };
  CreateParams: { filePath: string };
  UpdateParams: { filePath: string };
  ReadResult: void;
};

const zipResource = resource<ZipSchema>({
  type: "std/fs/Zip",
});

export const zipSchema = zipResource.defineSchema({
  filePath: {
    valueType: z.string(),
    propertyType: "param",
    presence: "required",
    primaryKey: true,
  },
  sourceSha256: {
    valueType: z.string(),
    propertyType: "param",
    presence: "required",
  },
} as const);

export const Zip = zipSchema.defineOperations({
  deriveParams: async ({ config }) => {
    const sourceSha256 = await zip.getSourceSha256(config.filePath!);
    return { sourceSha256 };
  },
  create: async (params) => {
    await zip.package(params.filePath);
  },
  update: async (config) => {
    await zip.delete(config.filePath);
    await zip.package(config.filePath);
  },
  delete: async (config) => {
    await zip.delete(config.filePath);
  },
});

export const getZip = (filePath: string) => zip.read(filePath);

export type ZipFileInstance = InstanceType<typeof Zip>;
