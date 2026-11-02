import type {
  RuntimeModule,
  StaticValue,
} from "src/parsers/parse-runtime-module";

/**
 * The module that replaces a runtime module in the infra phase. It declares
 * the module's resource, and exports a reference to it for each export of the
 * runtime module. None of the runtime module's code is kept.
 * @param codePath The path of the runtime bundle, relative to the project root.
 */
export function createResourceModule(
  { resource, exports }: RuntimeModule,
  codePath: string,
) {
  const { platform, service } = splitService(resource.service);
  const { service: _, id, ...config } = resource;
  const factoryConfig: Record<string, StaticValue> = {
    id,
    code: { type: "file", path: codePath },
    ...config,
  };

  // The aliases keep the generated names apart from the module's export names.
  const lines = [
    `import { ${service} as __notationFactory } from "@notation/${platform}/${service}";`,
    `const __notationResource = __notationFactory(${printValue(factoryConfig)});`,
    ...exports.map((name, index) => {
      const ref = `{ resource: __notationResource, export: ${JSON.stringify(name)} }`;
      if (!reservedWords.has(name)) return `export const ${name} = ${ref};`;
      // A reserved word is a valid export name but not a valid variable name.
      const local = `__notationRef${index}`;
      return `const ${local} = ${ref};\nexport { ${local} as ${name} };`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The entry of a runtime module's bundle. A function has one entry point, so
 * `createDispatcher` from the service's runtime package sends each event to
 * the right export of the module.
 * @param modulePath The absolute path of the runtime module.
 */
export function createRuntimeEntry(modulePath: string, service: string) {
  const { platform, service: name } = splitService(service);
  return [
    `import * as mod from ${JSON.stringify(modulePath)};`,
    `import { createDispatcher } from "@notation/${platform}/${name}.fn";`,
    `export const handler = createDispatcher(mod);`,
    ``,
  ].join("\n");
}

const reservedWords = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

function splitService(service: string) {
  const [platform, name] = service.split("/");
  return { platform: platform!, service: name! };
}

function printValue(value: StaticValue): string {
  if (Array.isArray(value)) return `[${value.map(printValue).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(
      ([key, item]) => `${printKey(key)}: ${printValue(item)}`,
    );
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(value);
}

function printKey(key: string) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}
