import { Plugin } from "esbuild";
import { parseFnModule } from "src/parsers/parse-fn-module";
import { removeUnsafeReferences } from "src/parsers/remove-unsafe-references";
import { GetFile, fsGetFile, withFileCheck } from "src/utils/get-file";
import { filePaths, toProjectRoot } from "@notation/core";

type PluginOpts = {
  getFile?: GetFile;
};

export function functionInfraPlugin(opts: PluginOpts = {}): Plugin {
  return {
    name: "function-infra",
    setup(build) {
      build.onLoad({ filter: /.\.fn*/ }, async (args) => {
        const getFile = withFileCheck(opts.getFile || fsGetFile);
        const fileContent = await getFile(args.path);
        const outFileName = toProjectRoot(
          filePaths.dist.runtime.index(args.path),
        );
        const safeFnModule = removeUnsafeReferences(fileContent);
        const { config, exports } = parseFnModule(fileContent);
        const filePath = toProjectRoot(args.path);
        const moduleId = getModuleId(config, filePath);

        const reservedNames = ["preload", "config"];
        const [platform, service] = (config.service as string).split("/");

        let infraCode = `import { ${service} } from "@notation/${platform}/${service}";\n`;
        infraCode = infraCode.concat(`\n${safeFnModule}\n`);

        for (const handlerName of exports) {
          if (reservedNames.includes(handlerName)) continue;
          const id = getFunctionId(moduleId, handlerName, filePath);
          infraCode = infraCode.concat(
            `export const ${handlerName} = ${service}({ code: { type: "file", path: "${outFileName}" }, handler: "${handlerName}", ...config, id: "${id}" });\n`,
          );
        }

        return {
          contents: infraCode,
          loader: "ts",
        };
      });
    },
  };
}

// a module id is combined with each handler name to form a function id,
// `<id>-<handler>`, which names cloud resources, so both are restricted to
// name-safe characters
const NAME_SAFE_PATTERN = /^[A-Za-z0-9_-]+$/;

// the function id is embedded in AWS names, the longest-limited being the IAM
// role name `<function id>-role` (at most 64 chars); mirrors
// LAMBDA_ID_MAX_LENGTH in @notation/aws
const FUNCTION_ID_MAX_LENGTH = 64 - "-role".length;

function getModuleId(config: Record<string, unknown>, filePath: string) {
  const id = config.id;
  if (id === undefined) {
    throw new Error(
      `${filePath}: the config export must set an id, e.g. \`id: "todos"\`. Each handler's function id is \`<id>-<handler>\`, so keep it stable: changing it replaces the functions.`,
    );
  }
  if (typeof id !== "string" || !NAME_SAFE_PATTERN.test(id)) {
    throw new Error(
      `${filePath}: invalid config id ${JSON.stringify(id)}. Use a string of letters (A-Z, a-z), digits, hyphens or underscores.`,
    );
  }
  return id;
}

function getFunctionId(
  moduleId: string,
  handlerName: string,
  filePath: string,
) {
  const id = `${moduleId}-${handlerName}`;
  if (!NAME_SAFE_PATTERN.test(id) || id.length > FUNCTION_ID_MAX_LENGTH) {
    throw new Error(
      `${filePath}: the function id ${JSON.stringify(id)} (\`<id>-<handler>\`) must be at most ${FUNCTION_ID_MAX_LENGTH} letters (A-Z, a-z), digits, hyphens or underscores. Shorten the config id or the handler name.`,
    );
  }
  return id;
}
