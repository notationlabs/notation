/** Runs `run` and returns what it threw, or undefined. */
export function catchError(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
