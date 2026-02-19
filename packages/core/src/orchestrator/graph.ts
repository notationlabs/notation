import path from "path";
import { filePaths } from "src/utils/paths";
import { ResourceCollector } from "./resource-collector";

export async function getResourceGraph(entryPoint: string) {
  const collector = new ResourceCollector();
  const outFilePath = filePaths.dist.infra(entryPoint);

  // todo: move into worker thread. this will cause memory leaks
  const mod = await import(path.join(process.cwd(), `${outFilePath}?${Date.now()}`));

  const register = (mod as any).register ?? (mod as any).default;

  if (typeof register !== "function") {
    throw new Error(
      `Infra entrypoint must export register(collector) (or a default function). Received exports: ${Object.keys(mod).join(
        ", ",
      )}`,
    );
  }

  await register(collector);

  return {
    resourceGroups: collector.getResourceGroups(),
    resources: collector.getResources(),
  };
}
