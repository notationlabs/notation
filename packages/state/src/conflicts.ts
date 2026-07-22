export class RevConflict extends Error {
  readonly name = "RevConflict";

  constructor(
    readonly id: string,
    readonly expectedRev: number,
    readonly actualRev: number | undefined,
  ) {
    super(
      `State revision conflict for ${id}: expected ${expectedRev}, got ${actualRev ?? "missing"}`,
    );
  }
}
