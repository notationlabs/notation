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

export class LeaseConflict extends Error {
  readonly name = "LeaseConflict";

  constructor(
    readonly scope: string,
    readonly expiresAt: string,
  ) {
    super(`State lease conflict for ${scope}: held until ${expiresAt}`);
  }
}
