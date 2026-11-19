/** A parsed `op://<vault>/<item>/[<section>/]<field>` reference. */
export type Reference = {
  text: string;
  vault: string;
  item: string;
  section?: string;
  field: string;
};

/** Parses a secret reference, and throws on a syntax error. */
export function parseReference(text: string): Reference {
  const fail = (reason: string): never => {
    throw new Error(
      `\`${text}\` is not a 1Password reference that notation can read. ${reason}`,
    );
  };
  if (!text.startsWith("op://")) {
    fail("It must start with `op://`.");
  }
  const [body, query] = splitOnce(text.slice("op://".length), "?");
  if (query !== undefined) {
    if (/(^|&)attribute=t?otp(&|$)/.test(query)) {
      fail(
        "A one-time password changes every 30 seconds, so it can't be deployed.",
      );
    }
    fail("Query attributes, such as `?ssh-format=openssh`, are not supported.");
  }
  const parts = body.split("/");
  if (parts.length < 3 || parts.length > 4 || parts.some((part) => !part)) {
    fail("Use the form `op://<vault>/<item>/[<section>/]<field>`.");
  }
  const [vault, item] = parts as [string, string];
  if (item.startsWith("-")) {
    fail(
      "The item's name starts with `-`, which op would read as a flag. Use the item's ID instead.",
    );
  }
  return parts.length === 4
    ? { text, vault, item, section: parts[2]!, field: parts[3]! }
    : { text, vault, item, field: parts[2]! };
}

function splitOnce(text: string, separator: string): [string, string?] {
  const index = text.indexOf(separator);
  return index === -1
    ? [text]
    : [text.slice(0, index), text.slice(index + separator.length)];
}
