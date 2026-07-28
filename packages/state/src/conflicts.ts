/**
 * A conditional state write or removal found the record moved past the
 * version it was read at. Nothing catches this: it fails the workflow, and
 * the constructor arguments exist to name the losing write in the message.
 */
export class VersionConflict extends Error {
  readonly name = "VersionConflict";

  constructor(
    id: string,
    expectedVersion: number,
    actualVersion: number | undefined,
  ) {
    super(
      `State version conflict for ${id}: expected ${expectedVersion}, got ${actualVersion ?? "missing"}`,
    );
  }
}
