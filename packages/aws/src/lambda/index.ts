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
