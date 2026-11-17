export {
  $lambda,
  type LambdaDeclarationConfig,
  type LambdaTarget,
} from "./lambda-declaration";
export * from "./declaration";
export {
  eventSourceMapping,
  type EventSourceMappingConfig,
  type SqsTarget,
} from "./event-source-mapping";
export {
  isLambdaGroup,
  lambda,
  LambdaGroup,
  type LambdaConfig,
} from "./lambda";
export { ID_MAX_LENGTH, isNameSafe, type NameSafe } from "src/id";
export type * from "./handler";
// The return type of $lambda names these types. TypeScript names the type
// of a declaration through this module when the project doesn't depend on
// @notation/resource.
export type {
  CredentialRef,
  Derived,
  OutputRef,
  Resolved,
  ResolvedValues,
} from "@notation/resource";
