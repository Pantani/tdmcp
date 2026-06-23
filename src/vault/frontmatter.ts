import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface ParsedNote {
  /** Parsed YAML frontmatter (empty object when the note has none). */
  data: Record<string, unknown>;
  /** Markdown body with the frontmatter stripped. */
  body: string;
}

/** Splits a markdown string into its YAML frontmatter and body. */
export function parseNote(raw: string): ParsedNote {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    return { data: {}, body: normalized };
  }

  const lines = normalized.split(/\r?\n/);
  const closingIndex = lines.findIndex((line, index) => index > 0 && isFrontmatterFence(line));
  if (closingIndex < 0) {
    return { data: {}, body: normalized };
  }

  const yaml = lines.slice(1, closingIndex).join("\n");
  const body = lines.slice(closingIndex + 1).join("\n");
  return { data: recordFromYaml(yaml), body };
}

/** Serializes frontmatter + body back into a markdown string. */
export function buildNote(data: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(data).trimEnd();
  const separator = body.length > 0 && !body.startsWith("\n") ? "\n" : "";
  return `---\n${yaml}\n---\n${separator}${body}`;
}

export function parseYamlDocument(raw: string): unknown {
  return parseYaml(raw) ?? {};
}

function isFrontmatterFence(line: string): boolean {
  return /^(---|\.{3})[ \t]*$/.test(line);
}

function recordFromYaml(raw: string): Record<string, unknown> {
  const parsed = parseYamlDocument(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
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
