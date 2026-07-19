declare module "node:sqlite" {
  export type StatementResult = { changes: number | bigint };
  export class StatementSync {
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
    run(...values: unknown[]): StatementResult;
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

// The shared tsconfig does not load @types/node, so declare the one export
// this package uses.
declare module "node:crypto" {
  export function randomUUID(): string;
}
