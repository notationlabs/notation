import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resource } from "@notation/resource";

type StaticSiteApi = {
  Key: { siteDirectory: string };
  CreateParams: { siteDirectory: string; html: string };
  UpdateParams: { siteDirectory: string; html: string };
  ReadResult: { html: string };
};

class SiteNotFound extends Error {
  readonly name = "SiteNotFound";
}

const staticSite = resource<StaticSiteApi>({ type: "local/site/static" });

export const StaticSite = staticSite
  .defineSchema({
    siteDirectory: {
      propertyType: "param",
      presence: "required",
      primaryKey: true,
    },
    html: {
      propertyType: "param",
      presence: "required",
    },
  } as const)
  .defineOperations({
    create: async ({ siteDirectory, html }) => {
      await mkdir(siteDirectory, { recursive: true });
      await writeFile(path.join(siteDirectory, "index.html"), html, "utf8");
    },
    read: async ({ siteDirectory }) => {
      try {
        const html = await readFile(
          path.join(siteDirectory, "index.html"),
          "utf8",
        );
        return { html };
      } catch (error) {
        if (isFileMissing(error)) throw new SiteNotFound(siteDirectory);
        throw error;
      }
    },
    update: async (_key, _patch, { siteDirectory, html }) => {
      await writeFile(path.join(siteDirectory, "index.html"), html, "utf8");
    },
    delete: async ({ siteDirectory }) => {
      await rm(siteDirectory, { recursive: true });
    },
    notFoundOnError: [{ name: "SiteNotFound", reason: "site was removed" }],
  });

function isFileMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
