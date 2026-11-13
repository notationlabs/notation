import {
  ResourceAlreadyExistsError,
  ResourceNotFoundError,
  ResourceOperationPendingError,
  SchemaStructureError,
  ValueValidationError,
} from "@notation/resource";
import { VersionConflict } from "@notation/state";
import { ResourceCycleError } from "../cycles";
import { ResourceTypeChangedError } from "../resource-type";
import { registerErrorClass } from "./sdk";

// @notation/durable rebuilds a recorded error from the class registered under its
// name, so `instanceof` only holds for registered classes.
registerErrorClass("VersionConflict", VersionConflict);
registerErrorClass(
  "ResourceOperationPendingError",
  ResourceOperationPendingError,
);
registerErrorClass("ResourceNotFoundError", ResourceNotFoundError);
registerErrorClass("ResourceAlreadyExistsError", ResourceAlreadyExistsError);
registerErrorClass("ValueValidationError", ValueValidationError);
registerErrorClass("SchemaStructureError", SchemaStructureError);
registerErrorClass("ResourceTypeChangedError", ResourceTypeChangedError);
registerErrorClass("ResourceCycleError", ResourceCycleError);
