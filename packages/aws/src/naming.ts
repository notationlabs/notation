import { perCollection, type PhysicalNameRule } from "@notation/resource";
import { nameBase } from "src/id";

/**
 * The rules of the AWS names that deploy generates: each is the
 * `physicalName` of the name param in the resource's schema. App, stage and
 * id characters are already valid in every one of them.
 */
export const nameRules = {
  // [a-zA-Z0-9-_]
  lambdaFunction: { maxLength: 64, base: nameBase },
  // [\w+=,.@-]
  iamRole: { maxLength: 64, base: nameBase },
  // [a-zA-Z0-9-_], a FIFO queue's name ends in .fifo
  sqsQueue: {
    maxLength: 80,
    requiredEnding: ".fifo",
    requiredEndingWhen: "FifoQueue",
    base: nameBase,
  },
  // [.\-_A-Za-z0-9], unique per event bus
  eventBridgeRule: { maxLength: 64, base: nameBase },
  // [/.\-_A-Za-z0-9]
  eventBridgeBus: { maxLength: 256, base: nameBase },
  // any characters, and not unique
  apiGatewayApi: { maxLength: 128, base: nameBase },
} satisfies Record<string, PhysicalNameRule>;

/**
 * Describes a declaration in errors, such as
 * `jwtAuthorizer({ id: "a", name: "b" })`.
 * @param caller The function that declares the resource, such as
 * `jwtAuthorizer()`.
 */
export function describeDeclaration(
  caller: string,
  id: string,
  name?: string,
): string {
  const options =
    name === undefined ? `id: "${id}"` : `id: "${id}", name: "${name}"`;
  return `${caller.replace(/\(\)$/, "")}({ ${options} })`;
}

// The declarations that gave each AWS name in a collection, keyed by kind and
// name.
const claims = perCollection(
  "@notation/aws/awsNameClaims",
  () => new Map<string, string>(),
);

/**
 * Records that `declaration` gives one of `kinds` the AWS name `name`.
 * Throws when another declaration in the deployment already gave one of
 * `kinds` the same name. Does nothing when no resource graph is being
 * collected.
 * @param kinds The kind of resource, in the plural. A kind whose names are
 * unique only within a parent names the parent, such as
 * `JWT authorizers of the API "todos"`.
 */
export function claimAwsName(
  kinds: string,
  name: string,
  declaration: string,
): void {
  const claimed = claims();
  if (!claimed) return;
  // A newline can't appear in a kind.
  const key = `${kinds}\n${name}`;
  const previous = claimed.get(key);
  if (previous) {
    throw new Error(
      `${previous} and ${declaration} give two ${kinds} the same AWS name, "${name}". Give one of them another name.`,
    );
  }
  claimed.set(key, declaration);
}
