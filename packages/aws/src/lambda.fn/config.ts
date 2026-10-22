export type LambdaConfig = {
  service: "aws/lambda";
  /**
   * Identifies the module's functions. Each exported handler becomes a
   * function with the id `<id>-<handler>`, which names the function and its
   * role, zip, policy and log group. Changing it replaces the functions, so
   * keep it stable.
   *
   * Letters, digits, hyphens and underscores only, and `<id>-<handler>` must
   * be at most 59 characters.
   */
  id: string;
  memory?: number;
  timeout?: number;
};
