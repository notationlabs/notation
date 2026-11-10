import crypto from "node:crypto";

/** The tag that records the create attempt that made a resource. */
export const CREATE_TOKEN_TAG = "notation:create-token";

/**
 * A token holds URI-encoded IDs, and a tag value cannot hold `%`, so the tag
 * holds the token's hex SHA-256.
 */
export function createTokenTagValue(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Removes the create token tag from tags a provider returned. */
export function withoutCreateTokenTag(
  tags: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!tags || !(CREATE_TOKEN_TAG in tags)) return tags;
  const { [CREATE_TOKEN_TAG]: _, ...rest } = tags;
  return Object.keys(rest).length > 0 ? rest : undefined;
}
