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

/**
 * A base64 SHA-256 of the bytes at `filePath`, the form in which AWS reports
 * a Lambda's `CodeSha256`.
 */
export const getFileSha256 = async (filePath: string) => {
  const file = await fs.readFile(fromProjectRoot(filePath));
  return crypto.createHash("sha256").update(file).digest("base64");
};
