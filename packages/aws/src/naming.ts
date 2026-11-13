import { perCollection } from "@notation/resource";

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
