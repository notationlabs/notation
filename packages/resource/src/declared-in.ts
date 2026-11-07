// The build writes its own copy of `declaredIn` into each declaration module,
// with this key, so the two must stay the same.
const declaredInKey = Symbol.for("@notation/declaredIn");

/** The module of a declaration, as the infra build records it. */
export type DeclaredIn = {
  /** The path of the module, relative to the project root, with `/` separators. */
  path: string;
  /** The local name of the binding that holds the declaration. */
  binding: string;
};

/**
 * Records the module of a declaration against the value that the declaration
 * returns, and returns the value. The infra build wraps each declaration in
 * a call like this one.
 */
export function declaredIn<T>(value: T, path: string, binding: string): T {
  if (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) {
    Object.defineProperty(value, declaredInKey, { value: { path, binding } });
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
