import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import {
  TD_DOCS_INDEX_CACHE_ROOTS,
  TD_DOCS_INDEX_CACHE_TTL_MS,
  TD_DOCS_MAX_CANDIDATES,
  TD_DOCS_MAX_RAW_BYTES,
  TD_DOCS_NEGATIVE_CACHE_ENTRIES,
  TD_DOCS_NEGATIVE_CACHE_TTL_MS,
  TD_DOCS_PAGE_CACHE_CHARS,
  TD_DOCS_PAGE_CACHE_ENTRIES,
  TD_DOCS_WEB_CACHE_TTL_MS,
  TD_DOCS_WEB_DEADLINE_MS,
  TD_DOCS_WEB_REDIRECTS_MAX,
  TD_DOCS_WEB_REQUESTS_MAX,
  type TdDocsCandidate,
  type TdDocsDocument,
  type TdDocsKind,
  type TdDocsLookupRequest,
  type TdDocsMatch,
  type TdDocsParsedSection,
  type TdDocsResolvedKind,
  type TdDocsSourceLookup,
} from "../tdDocsTypes.js";

const MAC_OFFLINE_HELP_ROOT =
  "/Applications/TouchDesigner.app/Contents/Resources/tfs/Samples/Learn/OfflineHelp/https.docs.derivative.ca";
const WIKI_API = "https://docs.derivative.ca/api.php";
const WIKI_ORIGIN = "https://docs.derivative.ca";
const HTML_EXTENSION_RE = /\.html?$/i;

interface PageIndex {
  root: string;
  build?: string;
  files: string[];
  byFilename: Map<string, string>;
  byNormalizedStem: Map<string, string>;
  directoryMtimeMs: number;
}

interface IndexCacheEntry {
  index: PageIndex;
  expiresAt: number;
}

interface PageCacheEntry {
  document: TdDocsDocument;
  chars: number;
}

interface NegativeCacheEntry {
  candidates: TdDocsCandidate[];
  expiresAt: number;
}

interface WebCacheEntry {
  document: TdDocsDocument;
  expiresAt: number;
}

export interface TdOfflineHelpResolverOptions {
  rootOverride?: string;
  platform?: NodeJS.Platform;
  webEnabled?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface ResolvedFilename {
  filename: string;
  matchedBy: TdDocsMatch;
}

interface ParsedHtmlPage {
  title: string;
  intro: string;
  sections: TdDocsParsedSection[];
}

interface HtmlTag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: Record<string, string>;
  end: number;
}

interface HeadingCapture {
  level: number;
  id: string;
  text: string[];
}

interface ArticleTokenState {
  introParts: string[];
  bodyParts: string[];
  sections: TdDocsParsedSection[];
  sectionIds: Set<string>;
  currentSection?: TdDocsParsedSection;
  heading?: HeadingCapture;
  skipDepth: number;
  preDepth: number;
}

interface WebRequestState {
  requests: number;
  signal: AbortSignal;
}

const indexCache = new Map<string, IndexCacheEntry>();
const pageCache = new Map<string, PageCacheEntry>();
const negativeCache = new Map<string, NegativeCacheEntry>();
const webCache = new Map<string, WebCacheEntry>();
let pageCacheChars = 0;

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const SKIP_ELEMENTS = new Set(["script", "style", "noscript", "svg", "nav", "figure"]);
const BLOCK_BREAK_ELEMENTS = new Set([
  "p",
  "div",
  "blockquote",
  "li",
  "tr",
  "table",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
]);
const STRUCTURAL_TOKENS = new Map([
  ["open:br", "\n"],
  ["open:hr", "\n"],
  ["open:li", "\n- "],
  ["open:pre", "\n```\n"],
  ["close:pre", "\n```\n"],
  ["close:td", " | "],
  ["close:th", " | "],
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  hellip: "…",
  laquo: "«",
  larr: "←",
  lt: "<",
  mdash: "—",
  middot: "·",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  raquo: "»",
  rarr: "→",
};

function normalizedIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function pageStem(filename: string): string {
  return filename.replace(HTML_EXTENSION_RE, "");
}

function classifyPage(stem: string): TdDocsResolvedKind {
  if (/_class$/i.test(stem)) return "python";
  if (/_(top|chop|sop|dat|comp|mat|pop)$/i.test(stem)) return "operator";
  return "concept";
}

function pageCandidate(filename: string): TdDocsCandidate {
  const id = pageStem(filename);
  return { id, title: id.replaceAll("_", " "), kind: classifyPage(id) };
}

function trimLru<T>(cache: Map<string, T>, maximum: number): void {
  while (cache.size > maximum) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") return;
    cache.delete(oldest);
  }
}

function touchLru<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
}

function readAttribute(raw: string, name: string): string | undefined {
  const expression = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    "i",
  );
  const match = expression.exec(raw);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function findTagEnd(html: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < html.length; index++) {
    const character = html[index];
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? "" : character;
    } else if (character === ">" && !quote) {
      return index;
    }
  }
  return html.length - 1;
}

function parseTag(html: string, start: number): HtmlTag | undefined {
  if (html.startsWith("<!--", start)) {
    const close = html.indexOf("-->", start + 4);
    return {
      name: "!comment",
      closing: false,
      selfClosing: true,
      attributes: {},
      end: close < 0 ? html.length : close + 2,
    };
  }
  const end = findTagEnd(html, start);
  const raw = html.slice(start + 1, end).trim();
  if (!raw || raw.startsWith("!") || raw.startsWith("?")) {
    return { name: "!meta", closing: false, selfClosing: true, attributes: {}, end };
  }
  const closing = raw.startsWith("/");
  const body = closing ? raw.slice(1).trim() : raw;
  const nameMatch = /^([a-zA-Z][\w:-]*)/.exec(body);
  if (!nameMatch) return undefined;
  const name = (nameMatch[1] ?? "").toLowerCase();
  return {
    name,
    closing,
    selfClosing: raw.endsWith("/") || VOID_ELEMENTS.has(name),
    attributes: {
      class: readAttribute(body, "class") ?? "",
      id: readAttribute(body, "id") ?? "",
    },
    end,
  };
}

function decodeEntity(entity: string): string {
  const codePoint = (value: string, radix: number) => {
    const point = Number.parseInt(value, radix);
    if (
      !Number.isInteger(point) ||
      point < 0 ||
      point > 0x10ffff ||
      (point >= 0xd800 && point <= 0xdfff)
    ) {
      return `&${entity};`;
    }
    return String.fromCodePoint(point);
  };
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    return codePoint(entity.slice(2), 16);
  }
  if (entity.startsWith("#")) {
    return codePoint(entity.slice(1), 10);
  }
  return NAMED_ENTITIES[entity] ?? `&${entity};`;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) =>
    decodeEntity(entity),
  );
}

function normalizeMarkdown(text: string): string {
  const lines = text.replaceAll("\r", "").split("\n");
  const normalized: string[] = [];
  let inFence = false;
  for (const rawLine of lines) {
    const fence = rawLine.trim().startsWith("```");
    const line = inFence ? rawLine.replace(/[ \t]+$/g, "") : rawLine.replace(/[ \t]+/g, " ").trim();
    normalized.push(line);
    if (fence) inFence = !inFence;
  }
  return normalized
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasClass(tag: HtmlTag, className: string): boolean {
  return (tag.attributes.class ?? "").split(/\s+/).includes(className);
}

function shouldSkip(tag: HtmlTag): boolean {
  return (
    SKIP_ELEMENTS.has(tag.name) ||
    tag.attributes.id === "toc" ||
    tag.attributes.id === "catlinks" ||
    hasClass(tag, "mw-editsection") ||
    hasClass(tag, "printfooter") ||
    hasClass(tag, "noprint")
  );
}

function structuralToken(tag: HtmlTag, inPre: boolean): string {
  if (tag.name === "code" && !inPre) return "`";
  const key = `${tag.closing ? "close" : "open"}:${tag.name}`;
  return (
    STRUCTURAL_TOKENS.get(key) ?? (tag.closing && BLOCK_BREAK_ELEMENTS.has(tag.name) ? "\n" : "")
  );
}

function articleFragment(html: string): string {
  const match = /<div\b[^>]*\bid=["']mw-content-text["'][^>]*>/i.exec(html);
  if (!match || match.index === undefined) {
    if (/\bmw-parser-output\b/i.test(html)) return html;
    throw new Error("MediaWiki article body not found.");
  }
  const start = match.index + match[0].length;
  const tail = html.slice(start);
  const cuts = [
    tail.search(/<div\b[^>]*class=["'][^"']*printfooter/i),
    tail.search(/<div\b[^>]*id=["']catlinks["']/i),
  ].filter((index) => index >= 0);
  const end = cuts.length > 0 ? Math.min(...cuts) : tail.length;
  return tail.slice(0, end);
}

function pageTitle(html: string): string {
  const match = /<h1\b[^>]*id=["']firstHeading["'][^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (!match?.[1]) return "";
  return normalizeMarkdown(decodeEntities(match[1].replace(/<[^>]+>/g, " ")));
}

function uniqueSectionId(wanted: string, used: Set<string>): string {
  const base = wanted.trim() || "section";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}_${suffix}`;
    suffix++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function assignSectionParents(sections: TdDocsParsedSection[]): void {
  const stack: TdDocsParsedSection[] = [];
  for (const section of sections) {
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= section.level) stack.pop();
    const parent = stack.at(-1);
    if (parent) section.parent_id = parent.id;
    stack.push(section);
  }
}

function bodyTarget(state: ArticleTokenState): string[] {
  return state.currentSection ? state.bodyParts : state.introParts;
}

function flushArticleBody(state: ArticleTokenState): void {
  if (state.currentSection) {
    state.currentSection.content = normalizeMarkdown(state.bodyParts.join(""));
  }
  state.bodyParts.length = 0;
}

function appendArticleText(state: ArticleTokenState, text: string): void {
  const decoded = decodeEntities(text);
  if (state.heading) state.heading.text.push(decoded);
  else bodyTarget(state).push(decoded);
}

function consumeSkippedTag(state: ArticleTokenState, tag: HtmlTag): boolean {
  if (state.skipDepth > 0) {
    if (!tag.closing && !tag.selfClosing) state.skipDepth++;
    if (tag.closing) state.skipDepth--;
    return true;
  }
  if (tag.closing || !shouldSkip(tag)) return false;
  if (!tag.selfClosing) state.skipDepth = 1;
  return true;
}

function beginHeading(state: ArticleTokenState, tag: HtmlTag, level: number): void {
  if (state.currentSection) flushArticleBody(state);
  state.heading = { level, id: tag.attributes.id ?? "", text: [] };
}

function finishHeading(state: ArticleTokenState): void {
  const heading = state.heading;
  if (!heading) return;
  const title = normalizeMarkdown(decodeEntities(heading.text.join("").replace(/<[^>]+>/g, " ")));
  const fallbackId = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const id = uniqueSectionId(heading.id || fallbackId, state.sectionIds);
  state.currentSection = { id, title: title || id, level: heading.level, content: "" };
  state.sections.push(state.currentSection);
  state.heading = undefined;
}

function consumeHeadingTag(state: ArticleTokenState, tag: HtmlTag): boolean {
  const matched = /^h([1-6])$/.exec(tag.name);
  if (matched && !tag.closing) {
    beginHeading(state, tag, Number(matched[1]));
    return true;
  }
  if (state.heading && !tag.closing && tag.attributes.id && hasClass(tag, "mw-headline")) {
    state.heading.id ||= tag.attributes.id;
  }
  if (!matched || !tag.closing || !state.heading) return false;
  finishHeading(state);
  return true;
}

function consumeArticleTag(state: ArticleTokenState, tag: HtmlTag): void {
  if (consumeSkippedTag(state, tag) || consumeHeadingTag(state, tag)) return;
  if (tag.name === "pre") state.preDepth += tag.closing ? -1 : 1;
  if (!state.heading) bodyTarget(state).push(structuralToken(tag, state.preDepth > 0));
}

function newArticleTokenState(): ArticleTokenState {
  return {
    introParts: [],
    bodyParts: [],
    sections: [],
    sectionIds: new Set<string>(),
    skipDepth: 0,
    preDepth: 0,
  };
}

function consumeArticleFragment(
  state: ArticleTokenState,
  fragment: string,
  cursor: number,
): number | undefined {
  const tagStart = fragment.indexOf("<", cursor);
  const textEnd = tagStart < 0 ? fragment.length : tagStart;
  if (textEnd > cursor && state.skipDepth === 0) {
    appendArticleText(state, fragment.slice(cursor, textEnd));
  }
  if (tagStart < 0) return undefined;
  const tag = parseTag(fragment, tagStart);
  if (!tag) {
    bodyTarget(state).push("<");
    return tagStart + 1;
  }
  consumeArticleTag(state, tag);
  return tag.end + 1;
}

function tokenizeArticle(fragment: string): { intro: string; sections: TdDocsParsedSection[] } {
  const state = newArticleTokenState();
  let cursor = 0;
  while (cursor < fragment.length) {
    const next = consumeArticleFragment(state, fragment, cursor);
    if (next === undefined) break;
    cursor = next;
  }
  flushArticleBody(state);
  assignSectionParents(state.sections);
  return { intro: normalizeMarkdown(state.introParts.join("")), sections: state.sections };
}

export function parseTdOfflineHelpHtml(html: string, titleOverride?: string): ParsedHtmlPage {
  if (Buffer.byteLength(html, "utf8") > TD_DOCS_MAX_RAW_BYTES) {
    throw new Error(`Documentation page exceeds ${TD_DOCS_MAX_RAW_BYTES} bytes.`);
  }
  const title = titleOverride?.trim() || pageTitle(html);
  const article = tokenizeArticle(articleFragment(html));
  return { title, ...article };
}

function renderSection(section: TdDocsParsedSection): string {
  return [`${"#".repeat(section.level)} ${section.title}`, section.content]
    .filter(Boolean)
    .join("\n\n");
}

function pythonDefaultSections(page: ParsedHtmlPage): TdDocsParsedSection[] {
  const selected: TdDocsParsedSection[] = [];
  for (const candidate of page.sections) {
    if (candidate.level === 1 && /\bclass\b/i.test(candidate.title)) break;
    if (["members", "methods"].includes(candidate.title.trim().toLowerCase()))
      selected.push(candidate);
  }
  return selected;
}

function defaultSections(page: ParsedHtmlPage, kind: TdDocsResolvedKind): TdDocsParsedSection[] {
  if (kind === "python") return pythonDefaultSections(page);
  if (kind === "operator") {
    const summary = page.sections.find(
      (candidate) => candidate.title.trim().toLowerCase() === "summary",
    );
    return summary ? [summary] : [];
  }
  const first = page.sections.find((candidate) => candidate.content.trim());
  return first ? [first] : [];
}

function smartDefault(page: ParsedHtmlPage, kind: TdDocsResolvedKind): string {
  const parts = page.intro ? [page.intro] : [];
  parts.push(...defaultSections(page, kind).map(renderSection));
  if (parts.length === 0 && page.sections[0]) parts.push(renderSection(page.sections[0]));
  return normalizeMarkdown(parts.join("\n\n"));
}

function parsePlistVersion(contents: string): string | undefined {
  const valueFor = (key: string) => {
    const expression = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`);
    return expression.exec(contents)?.[1]?.trim();
  };
  const short = valueFor("CFBundleShortVersionString");
  const bundle = valueFor("CFBundleVersion");
  if (short && bundle && short !== bundle) return undefined;
  return short ?? bundle;
}

async function corpusBuild(root: string): Promise<string | undefined> {
  const marker = `${sep}Contents${sep}`;
  const markerIndex = root.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const contentsRoot = root.slice(0, markerIndex + marker.length - 1);
  try {
    return parsePlistVersion(await readFile(join(contentsRoot, "Info.plist"), "utf8"));
  } catch {
    return undefined;
  }
}

async function canonicalDocsRoot(root: string): Promise<string> {
  const canonical = await realpath(root);
  const metadata = await stat(canonical);
  if (!metadata.isDirectory() || basename(canonical) !== "https.docs.derivative.ca") {
    throw new Error("OfflineHelp root must be a https.docs.derivative.ca directory.");
  }
  return canonical;
}

async function buildPageIndex(root: string): Promise<PageIndex> {
  const canonical = await canonicalDocsRoot(root);
  const metadata = await stat(canonical);
  const entries = await readdir(canonical, { withFileTypes: true });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".htm") &&
        entry.name.toLowerCase() !== "index.htm",
    )
    .map((entry) => entry.name)
    .sort(compareUtf8);
  const byFilename = new Map<string, string>();
  const byNormalizedStem = new Map<string, string>();
  for (const file of files) {
    byFilename.set(file.toLowerCase(), file);
    byFilename.set(pageStem(file).toLowerCase(), file);
    const key = normalizedIdentity(pageStem(file));
    if (key && !byNormalizedStem.has(key)) byNormalizedStem.set(key, file);
  }
  return {
    root: canonical,
    build: await corpusBuild(canonical),
    files,
    byFilename,
    byNormalizedStem,
    directoryMtimeMs: metadata.mtimeMs,
  };
}

async function pageIndex(root: string, now: number): Promise<{ index: PageIndex; hit: boolean }> {
  const canonical = await canonicalDocsRoot(root);
  const cached = indexCache.get(canonical);
  if (cached && cached.expiresAt > now) {
    const current = await stat(canonical);
    if (current.mtimeMs === cached.index.directoryMtimeMs) {
      touchLru(indexCache, canonical, cached);
      return { index: cached.index, hit: true };
    }
  }
  const index = await buildPageIndex(canonical);
  touchLru(indexCache, canonical, { index, expiresAt: now + TD_DOCS_INDEX_CACHE_TTL_MS });
  trimLru(indexCache, TD_DOCS_INDEX_CACHE_ROOTS);
  return { index, hit: false };
}

function queryLooksLikePage(query: string): boolean {
  return query.includes("_") || HTML_EXTENSION_RE.test(query);
}

function compatibleKind(filename: string, requested: TdDocsKind): boolean {
  return requested === "auto" || classifyPage(pageStem(filename)) === requested;
}

function explicitFilename(
  index: PageIndex,
  query: string,
  kind: TdDocsKind,
): ResolvedFilename | undefined {
  if (!queryLooksLikePage(query)) return undefined;
  const filename = index.byFilename.get(query.toLowerCase());
  return filename && compatibleKind(filename, kind) ? { filename, matchedBy: "exact" } : undefined;
}

function classFilename(
  index: PageIndex,
  key: string,
  kind: TdDocsKind,
): ResolvedFilename | undefined {
  if (kind !== "auto" && kind !== "python") return undefined;
  const alreadyClass = key.endsWith("class");
  const filename = index.byNormalizedStem.get(alreadyClass ? key : `${key}class`);
  return filename
    ? { filename, matchedBy: alreadyClass ? "normalized" : "derived_class" }
    : undefined;
}

function normalizedFilename(
  index: PageIndex,
  key: string,
  kind: TdDocsKind,
): ResolvedFilename | undefined {
  if (kind === "python") return undefined;
  const filename = index.byNormalizedStem.get(key);
  return filename && compatibleKind(filename, kind)
    ? { filename, matchedBy: "normalized" }
    : undefined;
}

function directFilename(
  index: PageIndex,
  query: string,
  kind: TdDocsKind,
): ResolvedFilename | undefined {
  const explicit = explicitFilename(index, query, kind);
  if (explicit) return explicit;
  const key = normalizedIdentity(pageStem(query));
  if (!key) return undefined;
  return classFilename(index, key, kind) ?? normalizedFilename(index, key, kind);
}

function candidateScore(stem: string, compactQuery: string, terms: string[]): number {
  const compactStem = normalizedIdentity(stem);
  let score = compactStem === compactQuery ? 100 : 0;
  if (compactStem.startsWith(compactQuery)) score += 20;
  if (compactQuery && compactStem.includes(compactQuery)) score += 10;
  return terms.reduce((total, term) => total + (stem.toLowerCase().includes(term) ? 2 : 0), score);
}

function fuzzyCandidates(index: PageIndex, query: string, kind: TdDocsKind): TdDocsCandidate[] {
  const compactQuery = normalizedIdentity(query);
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return index.files
    .filter((filename) => compatibleKind(filename, kind))
    .map((filename) => ({
      score: candidateScore(pageStem(filename), compactQuery, terms),
      filename,
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || compareUtf8(left.filename, right.filename))
    .slice(0, TD_DOCS_MAX_CANDIDATES)
    .map((entry) => pageCandidate(entry.filename));
}

async function safePageRead(
  index: PageIndex,
  filename: string,
): Promise<{
  html: string;
  path: string;
  mtimeMs: number;
  size: number;
}> {
  if (!index.files.includes(filename))
    throw new Error("Page is not present in the OfflineHelp index.");
  const proposed = join(index.root, filename);
  const before = await lstat(proposed);
  if (before.isSymbolicLink() || !before.isFile())
    throw new Error("OfflineHelp page is not a regular file.");
  if (before.size > TD_DOCS_MAX_RAW_BYTES) {
    throw new Error(`OfflineHelp page exceeds ${TD_DOCS_MAX_RAW_BYTES} bytes.`);
  }
  const canonical = await realpath(proposed);
  if (dirname(canonical) !== index.root)
    throw new Error("OfflineHelp page escaped its source root.");
  const after = await lstat(canonical);
  if (after.isSymbolicLink() || !after.isFile() || after.size !== before.size) {
    throw new Error("OfflineHelp page changed during validation.");
  }
  const html = await readFile(canonical, "utf8");
  if (Buffer.byteLength(html, "utf8") > TD_DOCS_MAX_RAW_BYTES) {
    throw new Error(`OfflineHelp page exceeds ${TD_DOCS_MAX_RAW_BYTES} bytes.`);
  }
  return { html, path: canonical, mtimeMs: after.mtimeMs, size: after.size };
}

function storePageCache(key: string, document: TdDocsDocument): void {
  const chars =
    document.intro.length + document.sections.reduce((sum, item) => sum + item.content.length, 0);
  const previous = pageCache.get(key);
  if (previous) pageCacheChars -= previous.chars;
  touchLru(pageCache, key, { document, chars });
  pageCacheChars += chars;
  while (pageCache.size > TD_DOCS_PAGE_CACHE_ENTRIES || pageCacheChars > TD_DOCS_PAGE_CACHE_CHARS) {
    const oldest = pageCache.keys().next().value;
    if (typeof oldest !== "string") break;
    const entry = pageCache.get(oldest);
    if (entry) pageCacheChars -= entry.chars;
    pageCache.delete(oldest);
  }
}

async function installedDocument(
  index: PageIndex,
  resolved: ResolvedFilename,
): Promise<TdDocsDocument> {
  const source = await safePageRead(index, resolved.filename);
  const key = [source.path, index.build ?? "unknown", source.mtimeMs, source.size].join(":");
  const cached = pageCache.get(key);
  if (cached) {
    touchLru(pageCache, key, cached);
    return { ...cached.document, cache: "hit" };
  }
  const parsed = parseTdOfflineHelpHtml(source.html);
  const id = pageStem(resolved.filename);
  const kind = classifyPage(id);
  const document: TdDocsDocument = {
    page: {
      id,
      title: parsed.title || id.replaceAll("_", " "),
      kind,
      matched_by: resolved.matchedBy,
    },
    intro: parsed.intro,
    sections: parsed.sections,
    default_content: smartDefault(parsed, kind),
    source: "installed-offline",
    source_path: source.path,
    installed_corpus_build: index.build,
    cache: "miss",
  };
  storePageCache(key, document);
  return document;
}

function assertDeclaredResponseSize(response: Response): void {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > TD_DOCS_MAX_RAW_BYTES) {
    throw new Error(`Web documentation response exceeds ${TD_DOCS_MAX_RAW_BYTES} bytes.`);
  }
}

async function readStreamText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > TD_DOCS_MAX_RAW_BYTES) {
      await reader.cancel();
      throw new Error(`Web documentation response exceeds ${TD_DOCS_MAX_RAW_BYTES} bytes.`);
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

async function readResponseText(response: Response): Promise<string> {
  assertDeclaredResponseSize(response);
  if (response.body) return readStreamText(response.body);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > TD_DOCS_MAX_RAW_BYTES) {
    throw new Error("Web response too large.");
  }
  return text;
}

function assertAllowedWebUrl(url: URL): void {
  if (url.protocol !== "https:" || url.hostname !== "docs.derivative.ca") {
    throw new Error("Documentation web request left the Derivative HTTPS allowlist.");
  }
}

async function fetchAllowed(
  fetchImpl: typeof fetch,
  initial: URL,
  signal: AbortSignal,
): Promise<Response> {
  let url = initial;
  for (let redirects = 0; redirects <= TD_DOCS_WEB_REDIRECTS_MAX; redirects++) {
    assertAllowedWebUrl(url);
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { accept: "application/json" },
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Derivative docs redirect omitted its target.");
    if (redirects === TD_DOCS_WEB_REDIRECTS_MAX) throw new Error("Too many docs redirects.");
    url = new URL(location, url);
  }
  throw new Error("Too many docs redirects.");
}

async function wikiApi(
  fetchImpl: typeof fetch,
  params: Record<string, string>,
  state: WebRequestState,
): Promise<Record<string, unknown>> {
  state.requests++;
  if (state.requests > TD_DOCS_WEB_REQUESTS_MAX)
    throw new Error("Documentation web request limit exceeded.");
  const url = new URL(WIKI_API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchAllowed(fetchImpl, url, state.signal);
  if (!response.ok) throw new Error(`Derivative docs returned HTTP ${response.status}.`);
  const parsed = JSON.parse(await readResponseText(response));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Derivative docs returned malformed JSON.");
  }
  return parsed as Record<string, unknown>;
}

function webParseData(data: Record<string, unknown>): { title: string; html: string } | undefined {
  if (data.error) return undefined;
  const parse = data.parse;
  if (!parse || typeof parse !== "object" || Array.isArray(parse)) return undefined;
  const record = parse as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title : "";
  const text = record.text;
  if (typeof text === "string") return { title, html: text };
  if (text && typeof text === "object" && !Array.isArray(text)) {
    const legacy = (text as Record<string, unknown>)["*"];
    if (typeof legacy === "string") return { title, html: legacy };
  }
  return undefined;
}

async function parseWebTitle(
  fetchImpl: typeof fetch,
  title: string,
  state: WebRequestState,
): Promise<{ title: string; html: string } | undefined> {
  const data = await wikiApi(
    fetchImpl,
    {
      action: "parse",
      page: title,
      prop: "text",
      redirects: "1",
      disableeditsection: "1",
      disabletoc: "1",
      format: "json",
      formatversion: "2",
    },
    state,
  );
  return webParseData(data);
}

async function searchWebTitles(
  fetchImpl: typeof fetch,
  query: string,
  state: WebRequestState,
): Promise<string[]> {
  const data = await wikiApi(
    fetchImpl,
    {
      action: "query",
      list: "search",
      srsearch: query,
      srlimit: String(TD_DOCS_MAX_CANDIDATES),
      format: "json",
      formatversion: "2",
    },
    state,
  );
  const queryRecord = data.query;
  if (!queryRecord || typeof queryRecord !== "object" || Array.isArray(queryRecord)) return [];
  const hits = (queryRecord as Record<string, unknown>).search;
  if (!Array.isArray(hits)) return [];
  return hits
    .map((hit) =>
      hit && typeof hit === "object" ? (hit as Record<string, unknown>).title : undefined,
    )
    .filter((title): title is string => typeof title === "string")
    .slice(0, TD_DOCS_MAX_CANDIDATES);
}

function webInitialTitle(request: TdDocsLookupRequest): string {
  const stem = pageStem(request.query);
  if (
    (request.kind === "auto" || request.kind === "python") &&
    !normalizedIdentity(stem).endsWith("class")
  ) {
    return `${stem[0]?.toUpperCase() ?? ""}${stem.slice(1)}_Class`;
  }
  return stem;
}

function webCandidate(title: string): TdDocsCandidate {
  const id = title.trim().replaceAll(" ", "_");
  return { id, title, kind: classifyPage(id) };
}

function webDocument(
  parsed: { title: string; html: string },
  matchedBy: TdDocsMatch,
): TdDocsDocument {
  const page = parseTdOfflineHelpHtml(parsed.html, parsed.title);
  const id = parsed.title.replaceAll(" ", "_");
  const kind = classifyPage(id);
  return {
    page: { id, title: parsed.title, kind, matched_by: matchedBy },
    intro: page.intro,
    sections: page.sections,
    default_content: smartDefault(page, kind),
    source: "web",
    source_url: `${WIKI_ORIGIN}/${encodeURIComponent(id)}`,
    cache: "miss",
  };
}

function defaultRoot(options: TdOfflineHelpResolverOptions): string | undefined {
  if (options.rootOverride) return options.rootOverride;
  return (options.platform ?? process.platform) === "darwin" ? MAC_OFFLINE_HELP_ROOT : undefined;
}

function unavailableLookup(
  source: "installed-offline" | "web",
  code: "installed_docs_unavailable" | "web_disabled" | "web_fetch_failed",
  message: string,
): TdDocsSourceLookup {
  return {
    status: "source_unavailable",
    candidates: [],
    warnings: [{ code, message }],
    source,
    cache: "not_applicable",
  };
}

function installedMissingLookup(
  index: PageIndex,
  request: TdDocsLookupRequest,
  candidates: TdDocsCandidate[],
  cache: "hit" | "miss",
): TdDocsSourceLookup {
  return {
    status: "not_found",
    candidates,
    warnings: [
      { code: "installed_page_missing", message: `No installed page matched "${request.query}".` },
    ],
    source: "installed-offline",
    installed_corpus_build: index.build,
    cache,
  };
}

async function lookupInstalledIndex(
  index: PageIndex,
  indexHit: boolean,
  request: TdDocsLookupRequest,
  now: number,
): Promise<TdDocsSourceLookup> {
  const negativeKey = `${index.root}:${request.kind}:${normalizedIdentity(request.query)}`;
  const negative = negativeCache.get(negativeKey);
  if (negative && negative.expiresAt > now) {
    touchLru(negativeCache, negativeKey, negative);
    return installedMissingLookup(index, request, negative.candidates, "hit");
  }
  const resolved = directFilename(index, request.query, request.kind);
  if (!resolved) {
    const candidates = fuzzyCandidates(index, request.query, request.kind);
    touchLru(negativeCache, negativeKey, {
      candidates,
      expiresAt: now + TD_DOCS_NEGATIVE_CACHE_TTL_MS,
    });
    trimLru(negativeCache, TD_DOCS_NEGATIVE_CACHE_ENTRIES);
    return installedMissingLookup(index, request, candidates, indexHit ? "hit" : "miss");
  }
  const document = await installedDocument(index, resolved);
  return {
    status: "found",
    document,
    candidates: [],
    warnings: index.build
      ? []
      : [
          {
            code: "corpus_build_unknown",
            message: "The installed corpus build could not be proven.",
          },
        ],
    source: "installed-offline",
    installed_corpus_build: index.build,
    cache: document.cache,
  };
}

function latestWebWarning() {
  return {
    code: "web_latest_not_installed_build" as const,
    message: "Web documentation describes the latest published docs, not the installed TD build.",
  };
}

function cachedWebLookup(entry: WebCacheEntry): TdDocsSourceLookup {
  return {
    status: "found",
    document: { ...entry.document, cache: "hit" },
    candidates: [],
    warnings: [latestWebWarning()],
    source: "web",
    cache: "hit",
  };
}

async function resolveWebPage(
  fetchImpl: typeof fetch,
  request: TdDocsLookupRequest,
  state: WebRequestState,
): Promise<{ parsed?: { title: string; html: string }; matchedBy: TdDocsMatch; titles: string[] }> {
  const direct = await parseWebTitle(fetchImpl, webInitialTitle(request), state);
  if (direct) {
    return {
      parsed: direct,
      matchedBy: request.kind === "python" ? "derived_class" : "exact",
      titles: [],
    };
  }
  const titles = await searchWebTitles(fetchImpl, request.query, state);
  const chosen = titles.find((title) => {
    const kind = classifyPage(title.replaceAll(" ", "_"));
    return request.kind === "auto" || request.kind === kind;
  });
  return {
    parsed: chosen ? await parseWebTitle(fetchImpl, chosen, state) : undefined,
    matchedBy: "search",
    titles,
  };
}

async function freshWebLookup(
  fetchImpl: typeof fetch,
  request: TdDocsLookupRequest,
  state: WebRequestState,
  cacheKey: string,
  now: number,
): Promise<TdDocsSourceLookup> {
  const resolved = await resolveWebPage(fetchImpl, request, state);
  const candidates = resolved.titles.map(webCandidate).slice(0, TD_DOCS_MAX_CANDIDATES);
  if (!resolved.parsed) {
    return {
      status: "not_found",
      candidates,
      warnings: [latestWebWarning()],
      source: "web",
      cache: "miss",
    };
  }
  const document = webDocument(resolved.parsed, resolved.matchedBy);
  touchLru(webCache, cacheKey, {
    document,
    expiresAt: now + TD_DOCS_WEB_CACHE_TTL_MS,
  });
  trimLru(webCache, TD_DOCS_PAGE_CACHE_ENTRIES);
  return {
    status: "found",
    document,
    candidates,
    warnings: [latestWebWarning()],
    source: "web",
    cache: "miss",
  };
}

async function guardedWebLookup(
  fetchImpl: typeof fetch,
  request: TdDocsLookupRequest,
  cacheKey: string,
  now: number,
): Promise<TdDocsSourceLookup> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TD_DOCS_WEB_DEADLINE_MS);
  try {
    return await freshWebLookup(
      fetchImpl,
      request,
      { requests: 0, signal: controller.signal },
      cacheKey,
      now,
    );
  } catch (error) {
    return unavailableLookup(
      "web",
      "web_fetch_failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
}

export class TdOfflineHelpResolver {
  private readonly root: string | undefined;
  private readonly webEnabled: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: TdOfflineHelpResolverOptions = {}) {
    this.root = defaultRoot(options);
    this.webEnabled = options.webEnabled ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async resolveInstalled(request: TdDocsLookupRequest): Promise<TdDocsSourceLookup> {
    if (!this.root) {
      return unavailableLookup(
        "installed-offline",
        "installed_docs_unavailable",
        "No supported OfflineHelp root is configured.",
      );
    }
    try {
      const indexed = await pageIndex(this.root, this.now());
      return await lookupInstalledIndex(indexed.index, indexed.hit, request, this.now());
    } catch (error) {
      return unavailableLookup(
        "installed-offline",
        "installed_docs_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async resolveWeb(request: TdDocsLookupRequest): Promise<TdDocsSourceLookup> {
    if (!this.webEnabled) {
      return unavailableLookup("web", "web_disabled", "Web docs require TDMCP_TD_DOCS_WEB=1.");
    }
    const cacheKey = `${request.kind}:${normalizedIdentity(request.query)}`;
    const cached = webCache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) {
      touchLru(webCache, cacheKey, cached);
      return cachedWebLookup(cached);
    }
    return guardedWebLookup(this.fetchImpl, request, cacheKey, this.now());
  }
}

export function createDefaultTdDocsResolver(): TdOfflineHelpResolver {
  return new TdOfflineHelpResolver({
    rootOverride: process.env.TDMCP_TD_DOCS_ROOT,
    webEnabled: process.env.TDMCP_TD_DOCS_WEB === "1",
  });
}

export function clearTdDocsCachesForTests(): void {
  indexCache.clear();
  pageCache.clear();
  negativeCache.clear();
  webCache.clear();
  pageCacheChars = 0;
}

export function validateTdDocsQuery(value: string): boolean {
  const lowered = value.toLowerCase();
  return (
    !containsControlCharacter(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("..") &&
    !lowered.includes("%2f") &&
    !lowered.includes("%5c")
  );
}
