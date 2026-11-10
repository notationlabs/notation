import { node } from "./node";
import type { Platform } from "./types";
import { workerd } from "./workerd";

export type { Platform };

const platforms = { node, workerd } satisfies Record<string, Platform>;

export type PlatformName = keyof typeof platforms;

export const platformNames = Object.keys(platforms) as PlatformName[];

/** The platform of a declaration mark without a `platform:` clause. */
export const defaultPlatform = "node" satisfies PlatformName;

export const isPlatformName = (name: string): name is PlatformName =>
  Object.hasOwn(platforms, name);

export const platformOf = (name: PlatformName = defaultPlatform): Platform =>
  platforms[name];
