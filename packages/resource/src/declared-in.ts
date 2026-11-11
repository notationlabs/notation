// The build writes its own copy of `declaredIn` into each declaration module,
// with this key. A test in @notation/build checks that the two copies match.
const declaredInKey = Symbol.for("@notation/declaredIn");

/**
 * The module that an infra declaration is in. `exports` and `starExports`
 * are only recorded for a platform that needs the module's exports in the
 * function's bundle, such as workerd.
 */
export type DeclaredIn = {
  /** The path of the module, relative to the project root, with `/` separators. */
  path: string;
  /** The local name of the binding that holds the declaration. */
  binding: string;
} & Partial<DeclaredExports>;

export type DeclaredExports = {
  /**
   * The module's export names, excluding the infra declaration and the
   * exports that satisfy the runtime platform's contract.
   */
  exports: string[];
  /**
   * The sources of the module's `export * from` statements, e.g.
   * `"./counter"`.
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
