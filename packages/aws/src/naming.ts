import {
  perCollection,
  scopedPhysicalName,
  type PhysicalNameRule,
} from "@notation/resource";

/**
 * The length limits of the AWS names that Notation makes from a `name`
 * option. App, stage and name characters are already valid in every one of
 * them. A name that deploy generates takes its limit from `physicalName` in
 * the resource's schema.
 */
const rules = {
  // [a-zA-Z0-9-_]
  lambdaFunction: { maxLength: 64 },
  // [a-zA-Z0-9-_], a FIFO queue's name ends in .fifo
  sqsQueue: { maxLength: 80, requiredEnding: ".fifo" },
  // [.\-_A-Za-z0-9], unique per event bus
  eventBridgeRule: { maxLength: 64 },
  // [/.\-_A-Za-z0-9]
  eventBridgeBus: { maxLength: 256 },
  // any characters, and not unique
  apiGatewayApi: { maxLength: 128 },
} satisfies Record<string, PhysicalNameRule>;

/**
 * Makes the AWS name of a resource from its `name` option:
 * `<app>--<stage>--<name>`, shortened with a hash when it is too long for
 * the service.
 */
export function awsName(kind: keyof typeof rules, name: string): string {
  return scopedPhysicalName(name, rules[kind]);
}

/**
 * Describes a declaration in errors, such as `$lambda({ id: "a", name: "b" })`.
 * @param caller The function that declares the resource, such as `queue()`.
 * @param where The module of the declaration, when it is known.
 */
export function describeDeclaration(
  caller: string,
  id: string,
  name?: string,
  where?: string,
): string {
  const options =
    name === undefined ? `id: "${id}"` : `id: "${id}", name: "${name}"`;
  const call = `${caller.replace(/\(\)$/, "")}({ ${options} })`;
  return where ? `${call} in ${where}` : call;
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
 * @param kinds The kind of resource, in the plural, such as
 * `Lambda functions`. A kind whose names are unique only within a parent
 * names the parent, such as `JWT authorizers of the API "todos"`.
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
