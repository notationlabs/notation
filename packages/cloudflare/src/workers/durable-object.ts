import { getDeclaredIn, perCollection } from "@notation/resource";
import { assertNamespaceId } from "src/id";
import type {
  DurableObjectClass,
  DurableObjectDeclaration,
} from "./declaration";

export type DurableObjectDeclarationConfig<
  Id extends string,
  C extends DurableObjectClass,
> = {
  /**
   * Keep it stable. Renaming the class keeps the namespace's objects.
   * Changing the id and the class deletes them. Changing only the id fails
   * the deploy.
   */
  id: Id;
  /**
   * Pass the class by name, such as `class: Counter`. Each Worker that hosts
   * the namespace must export the class under that name.
   */
  class: C;
};

type Registered = { className: string };

// `Symbol.for`, so two installed copies of this package share it.
const registration = Symbol.for(
  "@notation/cloudflare/DurableObjectDeclaration",
);

export function registeredNamespace(value: unknown): Registered | undefined {
  return typeof value === "object" && value !== null && registration in value
    ? (value as { [registration]: Registered })[registration]
    : undefined;
}

const declaredIds = perCollection(
  "@notation/cloudflare/namespaceIds",
  () => new Set<string>(),
);

/**
 * Declares a Durable Object namespace. A Worker that binds it also hosts it
 * if the Worker's module exports the class.
 * @declaration shared: id; runtime: class
 */
export function $durableObject<
  const Id extends string,
  C extends DurableObjectClass,
>(config: DurableObjectDeclarationConfig<Id, C>): DurableObjectDeclaration<C> {
  assertNamespaceId("$durableObject", config.id);
  // The infra build replaces the class with a function of the same name. A
  // value that is not a name, such as `ns.Counter`, becomes a function with
  // an empty name.
  const className = (config.class as { name?: unknown } | undefined)?.name;
  if (typeof className !== "string" || className === "") {
    throw new Error(
      `$durableObject({ id: "${config.id}" }) expects class to name a class that its module declares or imports, such as \`class: Counter\`. Cloudflare finds the class by the name that the Worker exports it under.`,
    );
  }
  const ids = declaredIds();
  if (ids?.has(config.id)) {
    throw new Error(
      `Duplicate $durableObject id "${config.id}": another namespace in this deployment already uses it. Give each namespace a unique id.`,
    );
  }
  ids?.add(config.id);
  const declaration = {
    id: config.id,
  } as unknown as DurableObjectDeclaration<C>;
  Object.defineProperty(declaration, registration, {
    value: { className } satisfies Registered,
  });
  return declaration;
}

/** Names a namespace in errors, with its module if known. */
export function describeNamespace(namespace: DurableObjectDeclaration): string {
  const where = getDeclaredIn(namespace)?.path;
  const call = `$durableObject({ id: "${namespace.id}" })`;
  return where ? `${call} in ${where}` : call;
}
