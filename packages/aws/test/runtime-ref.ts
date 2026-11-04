import type { LambdaGroup, RuntimeRef } from "src/lambda";

// Stands in for an import of a runtime module's export. The generated module
// makes it a RuntimeRef, and TypeScript types it as the handler.
export const runtimeRef = (resource: LambdaGroup, name: string) =>
  ({ resource, export: name }) as RuntimeRef & ((...args: any[]) => any);
