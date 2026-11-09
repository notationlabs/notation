import {
  getActiveResourceCollection,
  scopedPhysicalName,
  type PhysicalNameRule,
} from "@notation/resource";

/**
 * The length limits of the AWS names that Notation generates. App, stage and
 * id characters are already valid in every one of them.
 */
const rules = {
  // [a-zA-Z0-9-_]
  lambdaFunction: { maxLength: 64 },
  // [\w+=,.@-], unique regardless of case
  iamRole: { maxLength: 64 },
  // [a-zA-Z0-9-_], a FIFO queue's name ends in .fifo
  sqsQueue: { maxLength: 80, requiredEnding: ".fifo" },
  // [.\-_A-Za-z0-9], unique per event bus
  eventBridgeRule: { maxLength: 64 },
  // any characters, and not unique
  apiGatewayApi: { maxLength: 128 },
} satisfies Record<string, PhysicalNameRule>;

/**
 * Makes the AWS name of a resource from its id: `<app>--<stage>--<id>`,
 * shortened with a hash when it is too long for the service.
 */
export function awsName(kind: keyof typeof rules, id: string): string {
  return scopedPhysicalName(id, rules[kind]);
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

type Claim = { declaration: string };

// The AWS names that each collection's declarations have given, by kind.
const claims = new WeakMap<object, Map<string, Claim>>();

/**
 * Records that `declaration` gives a resource of `kind` the AWS name `name`.
 * Throws when another declaration in the deployment already gave a resource
 * of that kind the same name. Does nothing when no resource graph is being
 * collected.
 * @param kind The kind of resource, such as `Lambda function`.
 * @param scope Limits the check to names in one parent, such as an API for
 * its authorizers.
 */
export function claimAwsName(
  kind: string,
  name: string,
  declaration: string,
  scope = "",
): void {
  const collection = getActiveResourceCollection();
  if (!collection) return;
  let claimed = claims.get(collection);
  if (!claimed) {
    claimed = new Map();
    claims.set(collection, claimed);
  }
  // A newline can't appear in a kind or a scope.
  const key = `${kind}\n${scope}\n${name}`;
  const previous = claimed.get(key);
  if (previous) {
    throw new Error(
      `${previous.declaration} and ${declaration} both give a ${kind} the AWS name "${name}". Give one of them another name.`,
    );
  }
  claimed.set(key, { declaration });
}
