/** Turns a `*`-glob into a case-insensitive RegExp (other regex metachars are escaped). */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped, "i");
}

/** The parent path of a TD node path, e.g. `/project1/moviein1` -> `/project1`. */
export function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}
