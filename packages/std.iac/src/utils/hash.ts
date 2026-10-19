import { fromProjectRoot } from "@notation/core";
import crypto from "crypto";
import fs from "node:fs/promises";

export const getSourceSha256 = async (filePath: string) => {
  const sourceBuffer = await fs.readFile(fromProjectRoot(filePath));
  const sourceSha256 = crypto
    .createHash("sha256")
    .update(sourceBuffer)
    .digest("hex");
  return sourceSha256;
};
