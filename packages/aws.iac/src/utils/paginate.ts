type Page<T> = { Items?: T[]; NextToken?: string };

/** Fetches pages until one holds an item that matches, and returns that item. */
export async function findInPages<T>(
  fetchPage: (nextToken: string | undefined) => Promise<Page<T>>,
  matches: (item: T) => boolean,
): Promise<T | undefined> {
  let nextToken: string | undefined;
  do {
    const page = await fetchPage(nextToken);
    const item = page.Items?.find(matches);
    if (item) return item;
    nextToken = page.NextToken;
  } while (nextToken);
  return undefined;
}
