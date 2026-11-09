import { createHash } from "node:crypto";

// The longest StatementId that Lambda's AddPermission accepts.
const MAX_LENGTH = 100;
const HASH_LENGTH = 12;

/**
 * Makes the StatementId of a Lambda permission from the ID of the resource
 * that holds it. A StatementId allows only `[0-9A-Za-z_-]`, so other
 * characters become `_`. An ID that is too long is cut, and ends with a hash
 * of the whole ID, so that two long IDs with a common start differ.
 */
export function statementId(id: string): string {
  const safe = id.replace(/[^0-9A-Za-z_-]/g, "_");
  if (safe.length <= MAX_LENGTH) return safe;
  const hash = createHash("sha256")
    .update(id)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  return `${safe.slice(0, MAX_LENGTH - HASH_LENGTH - 1)}-${hash}`;
}
