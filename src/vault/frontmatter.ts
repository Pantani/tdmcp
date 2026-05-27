import matter from "gray-matter";

export interface ParsedNote {
  /** Parsed YAML frontmatter (empty object when the note has none). */
  data: Record<string, unknown>;
  /** Markdown body with the frontmatter stripped. */
  body: string;
}

/** Splits a markdown string into its YAML frontmatter and body. */
export function parseNote(raw: string): ParsedNote {
  const file = matter(raw);
  return { data: file.data, body: file.content };
}

/** Serializes frontmatter + body back into a markdown string. */
export function buildNote(data: Record<string, unknown>, body: string): string {
  return matter.stringify(body, data);
}

/**
 * Extracts the first fenced code block tagged with `lang` (e.g. ```json or
 * ```glsl). Returns the block's inner text, or undefined when absent. The `lang`
 * tag may carry an extra info word (```json tdmcp-recipe) — only the first token
 * is matched.
 */
export function extractFencedBlock(body: string, lang: string): string | undefined {
  const fence = new RegExp(`\`\`\`${lang}(?:[^\\n]*)\\n([\\s\\S]*?)\`\`\``, "i");
  const match = body.match(fence);
  return match?.[1]?.replace(/\n$/, "");
}
