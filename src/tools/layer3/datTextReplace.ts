/**
 * Pure DAT find/replace helper — the count + uniqueness + replacement logic that
 * `edit_dat_content` runs against a DAT's whole text.
 *
 * Today `edit_dat_content` does this server-side inside a Python `exec` pass. The
 * `param_modes_rest_endpoint` feature promotes DAT text off `/api/exec`: the tool
 * fetches the current text via `GET …/text`, runs THIS pure function in TS, then
 * writes the result back via `PUT …/text` (see design §4.7a, option a). Keeping the
 * logic here — pure, dependency-free, exhaustively unit-tested — means the rewire
 * is a thin wiring change and the behaviour (0 matches → error, >1 without
 * replace_all → error, exactly 1 → 1 replacement) is locked in regardless of which
 * transport carries it.
 */

export interface DatTextReplaceResult {
  /** The new text after replacement (undefined when `error` is set). */
  text?: string;
  /** How many times `oldString` occurs in the input. */
  occurrences: number;
  /** How many occurrences were actually replaced. */
  replacements: number;
  /** Echo of the requested mode. */
  replaceAll: boolean;
  /** Set to a human-readable message when the edit is rejected (no write should happen). */
  error?: string;
}

/**
 * Count occurrences of `oldString` in `text` and produce the replaced text.
 *
 * Mirrors `edit_dat_content`'s contract exactly:
 *  - `oldString` must be non-empty (an empty needle is rejected — it would match
 *    everywhere and is almost always a mistake);
 *  - 0 occurrences → error (nothing to replace);
 *  - >1 occurrences without `replaceAll` → error (ambiguous; caller must add
 *    context or opt into replace-all);
 *  - exactly 1 (or `replaceAll`) → performs the replacement and reports counts.
 *
 * On error, `text` is left undefined so callers never write back a no-op.
 */
export function computeDatTextReplace(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): DatTextReplaceResult {
  if (oldString.length === 0) {
    return {
      occurrences: 0,
      replacements: 0,
      replaceAll,
      error: "old_string must not be empty.",
    };
  }

  const occurrences = countOccurrences(text, oldString);
  if (occurrences === 0) {
    return {
      occurrences,
      replacements: 0,
      replaceAll,
      error: "old_string not found.",
    };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      occurrences,
      replacements: 0,
      replaceAll,
      error:
        `old_string matches ${occurrences} times; ` +
        "pass replace_all:true to replace all, or add surrounding context for a unique match.",
    };
  }

  if (replaceAll) {
    return {
      text: text.split(oldString).join(newString),
      occurrences,
      replacements: occurrences,
      replaceAll,
    };
  }
  return {
    text: replaceFirst(text, oldString, newString),
    occurrences,
    replacements: 1,
    replaceAll,
  };
}

/** Non-overlapping count of `needle` in `haystack` (matches Python `str.count`). */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Replace only the first occurrence of `needle` (matches Python `str.replace(a,b,1)`). */
function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const index = haystack.indexOf(needle);
  if (index === -1) return haystack;
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}
