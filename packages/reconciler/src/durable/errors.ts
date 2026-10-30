import {
  ResourceNotFoundError,
  ResourceOperationPendingError,
} from "@notation/resource";
import { VersionConflict } from "@notation/state";
import { registerErrorClass } from "./yieldstar";

// Yieldstar rebuilds a recorded error from the class registered under its
// name, so `instanceof` only holds for registered classes.
registerErrorClass("VersionConflict", VersionConflict);
registerErrorClass(
  "ResourceOperationPendingError",
  ResourceOperationPendingError,
);
registerErrorClass("ResourceNotFoundError", ResourceNotFoundError);
