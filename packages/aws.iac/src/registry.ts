import { resourceClassesIn } from "@notation/resource";
import * as apiGateway from "./resources/api-gateway";
import * as eventBridge from "./resources/event-bridge";
import * as lambda from "./resources/lambda";
import * as sqs from "./resources/sqs";

export const resourceClasses = resourceClassesIn(
  apiGateway,
  eventBridge,
  lambda,
  sqs,
);
