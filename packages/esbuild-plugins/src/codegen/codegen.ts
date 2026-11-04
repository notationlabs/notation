import type { RuntimeFunction } from "@notation/resource";
import { strippedPrefix } from "src/infra-phase/strip";

/** The specifier that generated infra code imports the linking API from. */
export const runtimeLinkSpecifier = "notation:runtime-link";

/** The specifier prefix of a runtime module's stand-in module. */
export const standInPrefix = "notation-standin:";

/**
 * The module that a `type: "runtime"` import resolves to in the infra phase.
 * It exports one stand-in per export of the runtime module, and runs none of
 * the module's code.
 * @param module The runtime module, relative to the project root.
 */
export function createStandInModule(module: string, exports: string[]) {
  const lines = [
    `import { createStandIn } from ${JSON.stringify(runtimeLinkSpecifier)};`,
    ...exports.map((name, index) => {
      const local = `__notationStandIn${index}`;
      return `const ${local} = createStandIn(${JSON.stringify(module)}, ${JSON.stringify(name)});\nexport { ${local} as ${exportName(name)} };`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The entry of the infra bundle. It evaluates infra, and re-exports its
 * exports, then the stripped copy
 * of each runtime module, and then links the stand-ins that infra holds to
 * the runtime modules' exports. ES modules evaluate their imports in order,
 * so no runtime module runs before all of infra has. esbuild keys modules by
 * their import attributes too, so the entry imports each stand-in module with
 * the attribute that infra uses, which gives it the same instance.
 * @param entryPoint The absolute path of the infra entry.
 * @param runtimeModules The absolute path of each runtime module, and its
 * path relative to the project root.
 * @param infraModules The absolute path of each infra module that runtime
 * code imports `with { type: "infra" }`, and its key: its path relative to
 * the project root, without its extension. Linking resolves the values that
 * functions read from them.
 */
export function createInfraEntry(
  entryPoint: string,
  runtimeModules: Array<{ path: string; module: string }>,
  infraModules: Array<{ path: string; module: string }> = [],
) {
  const lines = [`export * from ${JSON.stringify(entryPoint)};`];
  if (runtimeModules.length === 0) return `${lines[0]}\n`;
  lines.push(
    `import { linkRuntimeModules } from ${JSON.stringify(runtimeLinkSpecifier)};`,
  );
  infraModules.forEach(({ path }, index) => {
    lines.push(
      `import * as __notationInfra${index} from ${JSON.stringify(path)};`,
    );
  });
  runtimeModules.forEach(({ path }, index) => {
    lines.push(
      `import * as __notationStandIns${index} from ${JSON.stringify(`${standInPrefix}${path}`)} with { type: "runtime" };`,
      `import * as __notationRuntime${index} from ${JSON.stringify(`${strippedPrefix}${path}`)};`,
    );
  });
  const links = runtimeModules.map(
    ({ module }, index) =>
      `  { module: ${JSON.stringify(module)}, standIns: __notationStandIns${index}, exports: __notationRuntime${index} },`,
  );
  const infra = infraModules.map(
    ({ module }, index) =>
      `  ${JSON.stringify(module)}: __notationInfra${index},`,
  );
  lines.push(
    infra.length === 0
      ? `linkRuntimeModules([\n${links.join("\n")}\n]);`
      : `linkRuntimeModules([\n${links.join("\n")}\n], {\n${infra.join("\n")}\n});`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The entry of a function's bundle. Lambda calls its `handler` export, which
 * dispatches each event to one of the function's handlers. The dispatcher
 * comes from the service's runtime package, `@notation/<platform>/<service>.fn`,
 * which also gives `read` the values that infra delivers to the function.
 * @param resolve Gives the absolute path of a handler's module.
 */
export function createFunctionEntry(
  fn: RuntimeFunction,
  resolve: (module: string) => string,
) {
  const { platform, service } = splitService(fn.service);
  // The runtime package comes first, so that it is set up before any
  // handler's module runs.
  const lines = [
    `import { createDispatcher } from "@notation/${platform}/${service}.fn";`,
    ...fn.handlers.map(
      (handler, index) =>
        `import { ${exportName(handler.export)} as __notationHandler${index} } from ${JSON.stringify(resolve(handler.module))};`,
    ),
  ];
  const entries = fn.handlers.map(
    (handler, index) =>
      `  ${JSON.stringify(handler.export)}: __notationHandler${index},`,
  );
  lines.push(
    `export const handler = createDispatcher({\n${entries.join("\n")}\n});`,
  );
  return `${lines.join("\n")}\n`;
}

function exportName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function splitService(service: string) {
  const [platform, name] = service.split("/");
  return { platform: platform!, service: name! };
}
