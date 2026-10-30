import { resource, ResourceNotFoundError } from "@notation/resource";
import { isErrorWithCode } from "@notation/utils";
import { getFileSha256, getSourceSha256 } from "src/utils/hash";

export type FileSchema = {
  Key: { filePath: string };
  CreateParams: { filePath: string; sourceSha256: string };
  UpdateParams: { filePath: string; sourceSha256: string };
  ReadResult: { fileSha256: string };
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
  fileSha256: {
    propertyType: "computed",
    presence: "required",
  },
} as const);

export const File = fileSchema.defineOperations({
  deriveParams: async ({ config }) => {
    const sourceSha256 = await getSourceSha256(config.filePath!);
    return { sourceSha256 };
  },
  read: async (config) => {
    try {
      const fileSha256 = await getFileSha256(config.filePath);
      return { ...config, fileSha256 };
    } catch (error) {
      if (isErrorWithCode(error, "ENOENT")) {
        throw new ResourceNotFoundError("File was not found", { cause: error });
      }
      throw error;
    }
  },
  create: async () => {},
  update: async () => {},
  delete: async () => {},
});

export type FileInstance = InstanceType<typeof File>;
