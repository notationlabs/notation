import { resourceClassesIn } from "@notation/resource";
import * as fs from "./resources/fs";

/**
 * Every resource class that this package exports. Deploy and destroy find
 * the class of an orphaned state record here, so a record can be deleted
 * after its type has left the graph.
 */
export const resourceClasses = resourceClassesIn(fs);
