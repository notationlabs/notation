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
   * Keys the namespace. It can't change while the namespace exists: plan
   * fails. A change of `class` alone renames the class, and keeps the
   * namespace's objects.
   */
  id: Id;
  /**
   * Pass the class by name, such as `class: Counter`. Each Worker that hosts
   * the namespace must export the class under that name.
   */
  class: C;
  /**
   * Defaults to `true`: plan fails when a change would delete the namespace
   * and its objects. Plan reads the value saved when the hosting Worker was
   * last deployed, so deploy `protect: false` first. A later deploy can then
   * remove the namespace or its Worker.
   */
  protect?: boolean;
  /**
   * Runs a container for each object of the namespace. The hosting Worker's
   * upload declares the class as a container class, and deploy builds the
   * image and creates a container application for the namespace.
   */
  container?: DurableObjectContainerConfig;
};

export type DurableObjectContainerConfig = {
  /** The image that deploy builds with Docker and pushes to the account's Cloudflare registry. */
  image: {
    /** The build context directory, relative to the project root. */
    context: string;
    /**
     * The Dockerfile, relative to the project root. Defaults to `Dockerfile`
     * in the build context.
     */
    dockerfile?: string;
    /**
     * Passed to `docker build` as `--build-arg`. Don't put secrets here: the
     * values are kept in the image's history.
     */
    buildArgs?: Record<string, string>;
    /**
     * The repository in the account's Cloudflare registry. Defaults to
     * `<app>--<stage>--<id>`, with the id in lower case.
     */
    repository?: string;
  };
  /** The most containers that can run at once. */
  maxInstances: number;
  /**
   * Such as `"lite"`, `"basic"` or `"standard-1"`. Set either this, or
   * `vcpu` and `memoryMib`. Without any of them, Cloudflare uses `lite`.
   */
  instanceType?: string;
  vcpu?: number;
  memoryMib?: number;
  /** The disk size in MB. Set it only with `vcpu` and `memoryMib`. */
  diskMb?: number;
  /**
   * Don't put secrets here. The values are stored as plain text in state and
   * shown in plan output.
   */
  environmentVariables?: Record<string, string>;
  network?: {
    /** Cloudflare can't change the mode of an existing application. */
    mode?: "private" | "public";
    assignIpv4?: "none" | "predefined";
    assignIpv6?: "none" | "predefined";
  };
};

export type Registered = {
  className: string;
  protect: boolean;
  container?: DurableObjectContainerConfig;
};

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
  // value that is not an identifier, e.g. `ns.Counter`, becomes a function
  // with an empty name.
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
  if (config.container !== undefined)
    assertContainer(config.id, config.container);
  ids?.add(config.id);
  const declaration = {
    id: config.id,
  } as unknown as DurableObjectDeclaration<C>;
  Object.defineProperty(declaration, registration, {
    value: {
      className,
      protect: config.protect ?? true,
      container: config.container,
    } satisfies Registered,
  });
  return declaration;
}

/** Names a namespace in errors, with its module if known. */
export function describeNamespace(namespace: DurableObjectDeclaration): string {
  const where = getDeclaredIn(namespace)?.path;
  const call = `$durableObject({ id: "${namespace.id}" })`;
  return where ? `${call} in ${where}` : call;
}

function assertContainer(id: string, container: unknown) {
  const image = (container as { image?: { context?: unknown } } | null)?.image;
  if (typeof container !== "object" || typeof image?.context !== "string") {
    throw new Error(
      `$durableObject({ id: "${id}" }) expects container to be an object with image.context, the build context directory of the image, such as \`container: { image: { context: "containers/sandbox" }, maxInstances: 1 }\`.`,
    );
  }
}
