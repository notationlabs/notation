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

        const reservedNames = ["preload", "config"];
        const [platform, service] = (config.service as string).split("/");

        let infraCode = `import { ${service} } from "@notation/${platform}/${service}";\n`;
        infraCode = infraCode.concat(`\n${safeFnModule}\n`);

        for (const handlerName of exports) {
          if (reservedNames.includes(handlerName)) continue;
          infraCode = infraCode.concat(
            `export const ${handlerName} = ${service}({ code: { type: "file", path: "${outFileName}" }, handler: "${handlerName}", ...config });\n`,
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
