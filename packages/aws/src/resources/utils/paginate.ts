import { ResourceNotFoundError } from "@notation/resource";

type Page<T> = { Items?: T[]; NextToken?: string };

/**
 * Fetches every page, and returns the one item that matches. Throws
 * `ResourceNotFoundError` when no item matches. Throws an error that lists
 * the matches, each named by `describe`, when several match.
 */
export async function findOnlyInPages<T>(
  fetchPage: (nextToken: string | undefined) => Promise<Page<T>>,
  matches: (item: T) => boolean,
  what: string,
  describe: (item: T) => string,
): Promise<T> {
  const found: T[] = [];
  let nextToken: string | undefined;
  do {
    const page = await fetchPage(nextToken);
    found.push(...(page.Items ?? []).filter(matches));
    nextToken = page.NextToken;
  } while (nextToken);
  if (found.length === 0) throw new ResourceNotFoundError(`No ${what}`);
  if (found.length > 1) {
    throw new Error(
      `Found ${found.length} resources for ${what}, so cannot tell which ` +
        `one to use: ${found.map(describe).join(", ")}. Delete all but one.`,
    );
  }
  return found[0]!;
}
