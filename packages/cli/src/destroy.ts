import { createNdjsonEventEmitter, destroyApp } from "@notation/core";
import { compile } from "./compile";
import { redirectStdoutToStderr } from "./stdio";

export type DestroyCommandOptions = {
  json?: boolean;
};

export async function destroy(
  entryPoint: string,
  opts: DestroyCommandOptions = {},
) {
  const emit = opts.json
    ? createNdjsonEventEmitter(redirectStdoutToStderr().write)
    : undefined;

  await compile(entryPoint);
  await destroyApp(entryPoint, undefined, undefined, emit);
}
