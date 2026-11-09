export {
  $lambda,
  type LambdaDeclarationConfig,
  type LambdaTarget,
} from "./lambda-declaration";
export * from "./declaration";
export {
  eventSourceMapping,
  type EventSourceMappingConfig,
} from "./event-source-mapping";
export {
  isLambdaGroup,
  lambda,
  LambdaGroup,
  type LambdaConfig,
} from "./lambda";
export { isNameSafe, LAMBDA_ID_MAX_LENGTH, type NameSafe } from "./lambda-id";
