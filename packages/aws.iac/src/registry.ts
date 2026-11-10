import { resourceClassesIn } from "@notation/resource";
import * as apiGateway from "./resources/api-gateway";
import * as eventBridge from "./resources/event-bridge";
import * as lambda from "./resources/lambda";
import * as sqs from "./resources/sqs";

/**
 * Deploy and destroy find the class of an orphaned state record here, so a
 * record can be deleted after its type has left the graph.
 */
export const resourceClasses = resourceClassesIn(
  apiGateway,
  eventBridge,
  lambda,
  sqs,
);
