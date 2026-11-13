import { Redacted, type Source, type SourceContext } from "@notation/core";
import { request, siteUrl } from "./api";
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
  secretKey: string;
  secretValue: string;
  secretValueHidden?: boolean;
};

type Folder = Map<string, InfisicalSecret>;

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
        const url = new URL("/api/v4/secrets", site);
        url.search = new URLSearchParams({
          projectId: options.projectId,
          environment: env,
          secretPath: path,
          viewSecretValue: "true",
          expandSecretReferences: "true",
          includeImports: "false",
          recursive: "false",
        }).toString();
        const response = await request<{ secrets: InfisicalSecret[] }>(
          "GET",
          url,
          { token },
        );
        return new Map(response.secrets.map((s) => [s.secretKey, s]));
      },
    );
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
    has: async (key, context) => (await folder(context)).has(key),
    // The secret's ID is part of the version, because a secret that is
    // deleted and added again starts again at version 1.
    version: async (key, context) => {
      const found = await secret(key, context);
      return `${found.id}:${found.version}`;
    },
    get: async (key, context) => {
      const found = await secret(key, context);
      if (found.secretValueHidden) {
        throw new Error(
          `The Infisical identity can't read the value of \`${key}\` in ${where(context)}. Give it a role that can read secret values.`,
        );
      }
      return new Redacted(found.secretValue);
    },
  };
}

function normalisePath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}`;
}
