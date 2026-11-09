// The longest StatementId that Lambda's AddPermission accepts.
const MAX_LENGTH = 100;

/**
 * Makes the StatementId of a Lambda permission from a prefix and the source
 * that the permission lets invoke the function, such as an API ID or a rule
 * name. A function can have one statement per source this way. A StatementId
 * allows only `[0-9A-Za-z_-]`, so other characters become `_`.
 */
export function statementId(prefix: string, source: string): string {
  const id = `${prefix}-${source}`.replace(/[^0-9A-Za-z_-]/g, "_");
  if (id.length > MAX_LENGTH) {
    throw new Error(
      `The StatementId "${id}" is longer than ${MAX_LENGTH} characters.`,
    );
  }
  return id;
}
