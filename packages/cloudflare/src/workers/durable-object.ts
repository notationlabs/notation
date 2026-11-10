import { getActiveResourceCollection, getDeclaredIn } from "@notation/resource";
import { assertNamespaceId, perCollection } from "src/id";
import type {
  DurableObjectClass,
  DurableObjectDeclaration,
} from "./declaration";

export type DurableObjectDeclarationConfig<
  Id extends string,
  C extends DurableObjectClass,
> = {
  /**
   * Keys the namespace. Its class can be renamed while the id stays the
   * same, and the namespace keeps its objects. Changing the id and the class
   * together deletes the namespace and its objects, and makes a new one.
   * Changing the id alone fails the deploy, as Cloudflare keys a namespace
   * by its class name. Keep the id stable.
   */
  id: Id;
  /**
   * The namespace's class, by name, such as `class: Counter`. Export the
   * class from the module of each Worker that hosts the namespace, under the
   * name written here, as Cloudflare finds the class by its export name.
   */
  class: C;
};

type Registered = { className: string };

// Two installed copies of this package each have their own module state, so
// the mark is a `Symbol.for` symbol, which both copies share.
const registration = Symbol.for(
  "@notation/cloudflare/DurableObjectDeclaration",
);

export function registeredNamespace(value: unknown): Registered | undefined {
  return typeof value === "object" && value !== null && registration in value
    ? (value as { [registration]: Registered })[registration]
    : undefined;
}

const declaredIds = perCollection("namespaceIds", () => new Set<string>());

/**
 * Declares a Durable Object namespace. A Worker binds it in its `bindings`,
 * and hosts it when the Worker's module exports the class.
 *
 * The module of the namespace holds only this declaration. Import the class
 * from it in each Worker that hosts the namespace, and export it again.
 * @declaration shared: id; runtime: class
 */
export function $durableObject<
  const Id extends string,
  C extends DurableObjectClass,
>(config: DurableObjectDeclarationConfig<Id, C>): DurableObjectDeclaration<C> {
  assertNamespaceId("$durableObject", config.id);
  // The infra build replaces the class with a function of the same name, as
  // the class may import modules, such as cloudflare:workers, that infra
  // can't load. A value that is not a name, such as `ns.Counter`, gets a
  // function with no name.
  const className = (config.class as { name?: unknown } | undefined)?.name;
  if (typeof className !== "string" || className === "") {
    throw new Error(
      `$durableObject({ id: "${config.id}" }) expects class to name a class that its module declares or imports, such as \`class: Counter\`. Cloudflare finds the class by the name that the Worker exports it under.`,
    );
  }
  if (getActiveResourceCollection()) {
    const ids = declaredIds();
    if (ids.has(config.id)) {
      throw new Error(
        `Duplicate $durableObject id "${config.id}": another namespace in this deployment already uses it. Give each namespace a unique id.`,
      );
    }
    ids.add(config.id);
  }
  const declaration = {
    id: config.id,
  } as unknown as DurableObjectDeclaration<C>;
  Object.defineProperty(declaration, registration, {
    value: { className } satisfies Registered,
  });
  return declaration;
}

/** Describes a namespace in errors, with its module when it is known. */
export function describeNamespace(namespace: DurableObjectDeclaration): string {
  const where = getDeclaredIn(namespace)?.path;
  const call = `$durableObject({ id: "${namespace.id}" })`;
  return where ? `${call} in ${where}` : call;
}
