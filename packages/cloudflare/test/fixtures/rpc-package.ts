// Only type-checked, as rpc-workers.ts. It stands in for the infra code of
// a package, which imports its Worker's class as a type only.
import type { BundleLike } from "@notation/build/resources";
import { entrypointType, worker } from "src/workers";
import type Channel from "./rpc-package-worker";

declare const code: BundleLike;

export const channel = worker({
  id: "channel",
  code,
  compatibilityDate: "2026-10-12",
  bindings: () => ({ NAME: "github" }),
  entrypoint: entrypointType<typeof Channel>(),
  url: false,
});

export const plainBundle = worker({
  id: "plain-bundle",
  code,
  compatibilityDate: "2026-10-12",
});

export const router = worker({
  id: "router",
  code,
  compatibilityDate: "2026-10-12",
  bindings: () => ({ CHANNEL: channel, PLAIN: plainBundle }),
});
