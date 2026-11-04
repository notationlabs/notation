import path from "node:path";
import esbuild, { BuildOptions, Plugin } from "esbuild";

export const projectRoot = "/project";

// Serves files from memory. Paths are relative to `projectRoot`. Bare
// imports, such as packages, stay external.
const virtualFilesPlugin = (files: Record<string, string>): Plugin => ({
  name: "virtual-files",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (!args.path.startsWith(".") && !path.isAbsolute(args.path)) {
        return { path: args.path, external: true };
      }
      const resolved = path.resolve(args.resolveDir || projectRoot, args.path);
      const relative = path.relative(projectRoot, resolved);
      const file = [relative, `${relative}.ts`].find((f) => f in files);
      return { path: path.join(projectRoot, file ?? relative) };
    });
    build.onLoad({ filter: /.*/ }, (args) => {
      const contents = files[path.relative(projectRoot, args.path)];
      if (contents === undefined) throw new Error(`No file ${args.path}`);
      return { contents, loader: "ts", resolveDir: path.dirname(args.path) };
    });
  },
});

export const readVirtualFile =
  (files: Record<string, string>) => (filePath: string) =>
    files[path.relative(projectRoot, filePath)];

export async function buildVirtual(
  files: Record<string, string>,
  entryPoint: string,
  plugins: Plugin[],
  options: BuildOptions = {},
) {
  const result = await buildVirtualResult(files, entryPoint, plugins, options);
  return result.outputFiles![0]!.text;
}

export async function buildVirtualResult(
  files: Record<string, string>,
  entryPoint: string,
  plugins: Plugin[],
  options: BuildOptions = {},
) {
  return esbuild.build({
    entryPoints: [path.join(projectRoot, entryPoint)],
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
    ...options,
    plugins: [...plugins, virtualFilesPlugin(files)],
  });
}
