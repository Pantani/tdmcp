function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function pushText(parts: string[], value: unknown): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) parts.push(trimmed);
  }
}

function flattenBlock(value: unknown, parts: string[]): void {
  if (!isRecord(value)) {
    pushText(parts, value);
    return;
  }

  pushText(parts, value.title);
  pushText(parts, value.text);
  for (const item of stringArray(value.items)) pushText(parts, item);
  if (Array.isArray(value.content)) {
    for (const child of value.content) flattenBlock(child, parts);
  }
}

export function flattenTutorialContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || undefined;
  }
  const parts: string[] = [];
  if (isRecord(content)) {
    if (Array.isArray(content.tableOfContents)) {
      for (const item of content.tableOfContents) flattenBlock(item, parts);
    }
    if (Array.isArray(content.sections)) {
      for (const section of content.sections) flattenBlock(section, parts);
    }
    if (Array.isArray(content.relatedLinks)) {
      for (const link of content.relatedLinks) flattenBlock(link, parts);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function sectionBody(section: Record<string, unknown>): string {
  const body: string[] = [];
  pushText(body, section.text);
  for (const item of stringArray(section.items)) pushText(body, item);
  if (Array.isArray(section.content)) {
    for (const child of section.content) flattenBlock(child, body);
  }
  return body.join("\n\n");
}

/**
 * Like {@link flattenTutorialContent} but emits a `## <title>` heading per top-level
 * section, so a large tutorial can be split into drill-in sections (see
 * `buildSectionView`). Falls back to the plain flatten when the content has no
 * section structure.
 */
function sectionTitle(section: unknown): string | undefined {
  if (isRecord(section) && typeof section.title === "string" && section.title.trim()) {
    return section.title.trim();
  }
  return undefined;
}

function appendSectionMarkdown(section: unknown, parts: string[]): void {
  const title = sectionTitle(section);
  if (!title || !isRecord(section)) {
    flattenBlock(section, parts);
    return;
  }
  parts.push(`## ${title}`);
  const body = sectionBody(section);
  if (body) parts.push(body);
}

export function tutorialContentToMarkdown(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || undefined;
  }
  if (!isRecord(content) || !Array.isArray(content.sections)) {
    return flattenTutorialContent(content);
  }
  const parts: string[] = [];
  for (const section of content.sections) appendSectionMarkdown(section, parts);
  return parts.length > 0 ? parts.join("\n\n") : flattenTutorialContent(content);
}

export function tutorialTextFields(tutorial: {
  id?: string;
  name?: string;
  displayName?: string;
  category?: string;
  subcategory?: string;
  description?: string;
  summary?: string;
  keywords?: string[];
  tags?: string[];
  content?: unknown;
}): string {
  return [
    tutorial.id,
    tutorial.name,
    tutorial.displayName,
    tutorial.category,
    tutorial.subcategory,
    tutorial.description,
    tutorial.summary,
    ...(tutorial.keywords ?? []),
    ...(tutorial.tags ?? []),
    flattenTutorialContent(tutorial.content),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

export function tutorialCodeBlocks(content: unknown): Array<{ language?: string; text: string }> {
  const blocks: Array<{ language?: string; text: string }> = [];
  const visit = (value: unknown) => {
    if (!isRecord(value)) return;
    if (value.type === "code" && typeof value.text === "string" && value.text.trim()) {
      blocks.push({
        language: typeof value.language === "string" ? value.language : undefined,
        text: value.text,
      });
    }
    if (Array.isArray(value.content)) {
      for (const child of value.content) visit(child);
    }
    if (Array.isArray(value.sections)) {
      for (const child of value.sections) visit(child);
    }
  };
  visit(content);
  return blocks;
}
