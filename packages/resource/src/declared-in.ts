// The build writes its own copy of `declaredIn` into each declaration module,
// with this key, so the two must stay the same.
const declaredInKey = Symbol.for("@notation/declaredIn");

/**
 * The module of a declaration, as the infra build records it. `exports` and
 * `starExports` are set together, for a module whose platform reads named
 * exports, such as a Worker module that exports its Durable Object classes.
 */
export type DeclaredIn = {
  /** The path of the module, relative to the project root, with `/` separators. */
  path: string;
  /** The local name of the binding that holds the declaration. */
  binding: string;
} & Partial<DeclaredExports>;

/**
 * The exports of a module whose platform reads named exports. The infra
 * build records them for a declaration marked `platform: workerd`.
 */
export type DeclaredExports = {
  /**
   * The value exports of the module that its bundle re-exports, other than
   * the entry and the declaration.
   */
  exports: string[];
  /**
   * The specifiers of the module's `export * from` statements. The bundle
   * doesn't re-export their names.
   */
  starExports: string[];
};

/**
 * Records the module of a declaration against the value that the declaration
 * returns, and returns the value. The infra build wraps each declaration in
 * a call like this one.
 */
export function declaredIn<T>(
  value: T,
  path: string,
  binding: string,
  moduleExports?: DeclaredExports,
): T {
  if (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) {
    Object.defineProperty(value, declaredInKey, {
      value: { path, binding, ...moduleExports },
    });
  }
  return value;
}

/** The module that the infra build recorded for a declaration. */
export function getDeclaredIn(value: unknown): DeclaredIn | undefined {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return undefined;
  }
  return (value as Record<symbol, DeclaredIn | undefined>)[declaredInKey];
}
