/** What a path may not continue from on its left: a letter, digit or name punctuation means the match is the tail of another path. */
const BEFORE_PATH = String.raw`(?<![\p{L}\p{N}_.~+@%-])`;
/** What may not follow a home: more name characters mean a different directory such as `/Users/macbook`. */
const AFTER_PATH = String.raw`(?![\p{L}\p{N}_.~+@%-])`;

export type RewriteResult = {
  text: string;
  /** Places that already held the destination home as a whole path prefix before the rewrite. */
  existing: number;
};

/**
 * Replaces `from` with `to` wherever `from` is a whole path prefix and keeps every
 * other character, so line endings, key order and text that is not JSON stay as they were.
 */
export function rewriteHome(text: string, from: string, to: string): RewriteResult {
  assertHome(from, "source");
  assertHome(to, "destination");
  const existing = [...text.matchAll(prefixPattern(to))].length;
  if (from === to) return { text, existing };
  return { text: text.replace(prefixPattern(from), () => to), existing };
}

function assertHome(home: string, role: string): void {
  if (!home.startsWith("/") || home.length < 2 || home.endsWith("/")) {
    throw new RangeError(`the ${role} home must be an absolute path without a trailing slash, got ${JSON.stringify(home)}`);
  }
}

function prefixPattern(home: string): RegExp {
  const literal = home.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`${BEFORE_PATH}${literal}${AFTER_PATH}`, "gu");
}
