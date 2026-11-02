import path from "node:path";

const templateApp = 'app: "notation-starter"';

export function toNameSafe(name: string) {
  const safe = path
    .basename(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 32)
    .replace(/^-+|-+$/g, "");
  return safe || "notation-app";
}

/** Sets the app in the starter's `notation.config.ts` source. */
export function setConfigApp(config: string, app: string) {
  if (!config.includes(templateApp)) {
    throw new Error(
      `The starter notation.config.ts has no ${templateApp} to replace`,
    );
  }
  return config.replace(templateApp, `app: "${app}"`);
}
