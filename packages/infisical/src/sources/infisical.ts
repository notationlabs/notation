import { Redacted, type Source, type SourceContext } from "@notation/core";
import { apiUrl, request, siteUrl } from "./api";
import { accessToken } from "./auth";

export type InfisicalOptions = {
  /** The ID of the Infisical project. */
  projectId: string;
  /** The environment's slug, such as `dev`, or a function of the stage that returns it. */
  environment: string | ((stage: string) => string);
  /** The folder to read. Defaults to `/`. */
  path?: string;
  /**
   * The URL of the Infisical instance. Defaults to `INFISICAL_DOMAIN`, and
   * then to `https://app.infisical.com`.
   */
  siteUrl?: string;
};

type InfisicalSecret = {
  id: string;
  version: number;
  type: "shared" | "personal";
  secretKey: string;
  secretValue: string;
  secretValueHidden?: boolean;
};

type FolderSecret = InfisicalSecret & {
  /** True when the raw value holds a reference to another secret. */
  referencing: boolean;
};

type Folder = Map<string, FolderSecret>;

// Infisical's reference syntax: `${KEY}`, `${env.KEY}`, `${env.folder.KEY}`.
const REFERENCE = /\$\{[^}]+\}/;

/**
 * Reads secret values from one folder of an Infisical project. The folder is
 * fetched once in each run of plan or deploy, and every key is answered from
 * that response. Secrets imported into the folder aren't read.
 *
 * It logs in with `INFISICAL_TOKEN`, or with a machine identity's client ID
 * and secret, or with `INFISICAL_IDENTITY_ID` and the CI platform's OIDC
 * token.
 */
export function infisical(options: InfisicalOptions): Source {
  const path = normalisePath(options.path ?? "/");
  // The infra is evaluated again in each run, which calls `infisical()`
  // again, so the responses are cached for one run.
  const cache = new Map<string, Promise<unknown>>();
  const cached = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    let entry = cache.get(key) as Promise<T> | undefined;
    if (!entry) {
      entry = load();
      cache.set(key, entry);
      // A failed request is tried again on the next call.
      entry.catch(() => cache.delete(key));
    }
    return entry;
  };

  const environment = ({ stage }: SourceContext) =>
    typeof options.environment === "function"
      ? options.environment(stage)
      : options.environment;

  const where = (context: SourceContext) =>
    `Infisical project ${options.projectId}, environment ${environment(context)}, path ${path}`;

  const folder = (context: SourceContext): Promise<Folder> => {
    const site = siteUrl(options.siteUrl);
    const env = environment(context);
    return cached(
      `folder ${site} ${options.projectId} ${env} ${path}`,
      async () => {
        const token = await cached(`token ${site}`, () => accessToken(site));
        const list = async (expand: boolean) => {
          const url = apiUrl(site, "/api/v4/secrets");
          url.search = new URLSearchParams({
            projectId: options.projectId,
            environment: env,
            secretPath: path,
            viewSecretValue: "true",
            expandSecretReferences: String(expand),
            includeImports: "false",
            includePersonalOverrides: "false",
            recursive: "false",
          }).toString();
          const response = await request<{ secrets: InfisicalSecret[] }>(
            "GET",
            url,
            { token },
          );
          // A personal override belongs to one user. It must never be
          // written to a shared store, so it is dropped even if the API
          // returns one.
          return response.secrets.filter((s) => s.type === "shared");
        };
        const [expanded, raw] = await Promise.all([list(true), list(false)]);
        const referencing = new Set(
          raw
            .filter((s) => REFERENCE.test(s.secretValue))
            .map((s) => s.secretKey),
        );
        return new Map(
          expanded.map((s) => [
            s.secretKey,
            { ...s, referencing: referencing.has(s.secretKey) },
          ]),
        );
      },
    );
  };

  // A value that the identity can't read fails `has` as well as `get`, so
  // that plan fails before deploy writes anything.
  const assertReadable = (
    found: InfisicalSecret,
    key: string,
    context: SourceContext,
  ) => {
    if (found.secretValueHidden) {
      throw new Error(
        `The Infisical identity can't read the value of \`${key}\` in ${where(context)}. Give it a role that can read secret values.`,
      );
    }
  };

  const secret = async (key: string, context: SourceContext) => {
    const found = (await folder(context)).get(key);
    if (!found) {
      throw new Error(`\`${key}\` isn't in ${where(context)}.`);
    }
    return found;
  };

  return {
    name: "infisical",
    has: async (key, context) => {
      const found = (await folder(context)).get(key);
      if (!found) return false;
      assertReadable(found, key, context);
      return true;
    },
    // The secret's ID is part of the version, because a secret that is
    // deleted and added again starts again at version 1. A secret that
    // references others has no version, because its version doesn't change
    // when a referenced secret changes. It is written on every deploy.
    version: async (key, context) => {
      const found = await secret(key, context);
      if (found.referencing) return undefined;
      return `${found.id}:${found.version}`;
    },
    get: async (key, context) => {
      const found = await secret(key, context);
      assertReadable(found, key, context);
      return new Redacted(found.secretValue);
    },
  };
}

function normalisePath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}`;
}
