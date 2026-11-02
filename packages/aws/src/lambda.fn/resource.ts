import type { LambdaConfig } from "src/lambda";

/**
 * The `resource` export of a runtime module that deploys as a Lambda. The
 * module deploys as one function, whatever number of handlers it exports.
 * Every field except `service` is passed to `lambda()`.
 */
export type LambdaResource = { service: "aws/lambda" } & Omit<
  LambdaConfig,
  "code"
>;
