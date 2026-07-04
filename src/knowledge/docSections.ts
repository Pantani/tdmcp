/**
 * Section-splitting for large embedded knowledge documents (tutorials, technique
 * packs). A full document can be tens of thousands of characters — expensive to
 * return whole when the agent only needs one part. These helpers slice a markdown
 * document into an intro + named sections so a tool can return a compact overview
 * by default and drill into one section on request, always capped to a budget.
 */

/** A single `#`-headed section of a markdown document. */
export interface DocSection {
  title: string;
  content: string;
}

/** Default response budget (chars). Large enough for one real section, small enough to stay cheap. */
export const DEFAULT_SECTION_CHAR_CAP = 30_000;

const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

type OpenSection = { title: string; lines: string[] };

function flushSection(sections: DocSection[], current: OpenSection | undefined): void {
  if (current) sections.push({ title: current.title, content: current.lines.join("\n").trim() });
}

function appendLine(current: OpenSection | undefined, introLines: string[], line: string): void {
  if (current) current.lines.push(line);
  else introLines.push(line);
}

/** Splits markdown into the intro (text before the first heading) and its `#`-headed sections. */
export function splitMarkdownSections(text: string): { intro: string; sections: DocSection[] } {
  const introLines: string[] = [];
  const sections: DocSection[] = [];
  let current: OpenSection | undefined;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    // A `#` inside a fenced code block is a comment/directive, not a heading.
    const heading = inFence ? null : HEADING_RE.exec(line);
    if (heading) {
      flushSection(sections, current);
      current = { title: heading[1] as string, lines: [] };
    } else {
      appendLine(current, introLines, line);
    }
  }
  flushSection(sections, current);
  return { intro: introLines.join("\n").trim(), sections };
}

/** Truncates `text` to at most `maxChars` at a line boundary, appending a narrowing hint. */
export function capText(
  text: string,
  maxChars = DEFAULT_SECTION_CHAR_CAP,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const slice = text.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf("\n");
  const body = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
  return {
    text: `${body}\n\n… [truncated at ${maxChars} chars — pass a specific \`section\` to narrow this response]`,
    truncated: true,
  };
}

/** A compact, sectioned view of a large document. */
export interface SectionView {
  /** Text before the first heading (empty when the doc opens with a heading). */
  intro: string;
  /** Titles of every `#`-headed section, so the agent knows what it can drill into. */
  sections_available: string[];
  /** The requested section, when a `section` was asked for and matched. */
  section?: DocSection;
  /** The returned body text (intro overview, or the requested section), capped. */
  content: string;
  /** True when `content` was truncated to the char cap. */
  truncated: boolean;
}

function findSection(sections: DocSection[], wanted: string): DocSection | undefined {
  const key = wanted.trim().toLowerCase();
  return (
    sections.find((s) => s.title.toLowerCase() === key) ??
    sections.find((s) => s.title.toLowerCase().includes(key))
  );
}

/**
 * Builds a sectioned view of a document.
 *
 * - With a matching `section`: returns just that section's content (capped).
 * - Otherwise, if the whole document fits the cap: returns it in full plus the list
 *   of available section titles (cheapest for small docs — no extra round-trip).
 * - Otherwise (document exceeds the cap): collapses to the intro + section list so
 *   the agent can drill into one section instead of paying for the whole thing.
 */
export function buildSectionView(
  text: string,
  opts: { section?: string; maxChars?: number } = {},
): SectionView {
  const maxChars = opts.maxChars ?? DEFAULT_SECTION_CHAR_CAP;
  const { intro, sections } = splitMarkdownSections(text);
  const sections_available = sections.map((s) => s.title);

  if (opts.section) {
    const matched = findSection(sections, opts.section);
    if (matched) {
      const capped = capText(matched.content, maxChars);
      return {
        intro,
        sections_available,
        section: matched,
        content: capped.text,
        truncated: capped.truncated,
      };
    }
  }

  if (text.length <= maxChars) {
    return { intro, sections_available, content: text, truncated: false };
  }

  // Too big to return whole: show the intro + a drill-in menu of section titles.
  const overviewBody = sections_available.length
    ? [intro, `Sections available: ${sections_available.join(", ")}.`].filter(Boolean).join("\n\n")
    : text;
  const capped = capText(overviewBody, maxChars);
  return { intro, sections_available, content: capped.text, truncated: capped.truncated };
}
