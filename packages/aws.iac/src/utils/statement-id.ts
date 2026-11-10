import { createHash } from "node:crypto";

// The longest StatementId that Lambda's AddPermission accepts.
const MAX_LENGTH = 100;
const HASH_LENGTH = 12;
const ALLOWED = /^[0-9A-Za-z_-]+$/;

/**
 * Makes the StatementId of a Lambda permission from the ID of the resource
 * that holds it. An ID that Lambda accepts is used as it is. A StatementId
 * allows only `[0-9A-Za-z_-]`, so in any other ID the other characters become
 * `_`, and the result is cut to fit and ends with a hash of the whole ID. The
 * hash keeps apart two IDs that differ only in a replaced character, such as
 * `p:a.b` and `p:a_b`, and two long IDs with a common start.
 */
export function statementId(id: string): string {
  if (ALLOWED.test(id) && id.length <= MAX_LENGTH) return id;
  const safe = id.replace(/[^0-9A-Za-z_-]/g, "_");
  const hash = createHash("sha256")
    .update(id)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  return `${safe.slice(0, MAX_LENGTH - HASH_LENGTH - 1)}-${hash}`;
}
