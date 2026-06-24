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
