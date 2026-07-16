export const TD_DOCS_DEFAULT_CONTENT_CHARS = 6_000;
export const TD_DOCS_MAX_CONTENT_CHARS = 12_000;
export const TD_DOCS_MAX_RAW_BYTES = 1_048_576;
export const TD_DOCS_MAX_SECTIONS = 80;
export const TD_DOCS_MAX_CANDIDATES = 5;
export const TD_DOCS_WEB_REQUESTS_MAX = 3;
export const TD_DOCS_WEB_DEADLINE_MS = 5_000;
export const TD_DOCS_WEB_REDIRECTS_MAX = 2;
export const TD_DOCS_INDEX_CACHE_ROOTS = 4;
export const TD_DOCS_INDEX_CACHE_TTL_MS = 300_000;
export const TD_DOCS_PAGE_CACHE_ENTRIES = 32;
export const TD_DOCS_PAGE_CACHE_CHARS = 4_000_000;
export const TD_DOCS_WEB_CACHE_TTL_MS = 900_000;
export const TD_DOCS_NEGATIVE_CACHE_ENTRIES = 64;
export const TD_DOCS_NEGATIVE_CACHE_TTL_MS = 60_000;

export const tdDocsKinds = ["auto", "operator", "python", "concept"] as const;
export type TdDocsKind = (typeof tdDocsKinds)[number];
export type TdDocsResolvedKind = Exclude<TdDocsKind, "auto">;

export const tdDocsSources = ["auto", "installed", "embedded", "web"] as const;
export type TdDocsSourcePolicy = (typeof tdDocsSources)[number];
export type TdDocsSource = "installed-offline" | "embedded" | "web";

export type TdDocsStatus = "found" | "not_found" | "section_not_found" | "source_unavailable";
export type TdDocsMatch = "exact" | "normalized" | "derived_class" | "search" | "embedded";
export type TdDocsBuildRelation = "match" | "mismatch" | "unknown";
export type TdDocsCacheStatus = "hit" | "miss" | "not_applicable";

export type TdDocsWarningCode =
  | "running_build_unavailable"
  | "corpus_build_unknown"
  | "build_mismatch"
  | "installed_docs_unavailable"
  | "installed_page_missing"
  | "embedded_fallback"
  | "web_disabled"
  | "web_latest_not_installed_build"
  | "web_fetch_failed"
  | "content_truncated"
  | "sections_truncated";

export interface TdDocsWarning {
  code: TdDocsWarningCode;
  message: string;
}

export interface TdDocsSection {
  id: string;
  title: string;
  level: number;
  parent_id?: string;
}

export interface TdDocsParsedSection extends TdDocsSection {
  content: string;
}

export interface TdDocsPageIdentity {
  id: string;
  title: string;
  kind: TdDocsResolvedKind;
  matched_by: TdDocsMatch;
}

export interface TdDocsCandidate {
  id: string;
  title: string;
  kind: TdDocsResolvedKind;
}

export interface TdDocsDocument {
  page: TdDocsPageIdentity;
  intro: string;
  sections: TdDocsParsedSection[];
  default_content: string;
  source: TdDocsSource;
  source_path?: string;
  source_url?: string;
  installed_corpus_build?: string;
  cache: TdDocsCacheStatus;
}

export interface TdDocsLookupRequest {
  query: string;
  kind: TdDocsKind;
  section?: string;
  source: TdDocsSourcePolicy;
  web_fallback: boolean;
  max_chars: number;
}

export interface TdDocsSourceLookup {
  status: "found" | "not_found" | "source_unavailable";
  document?: TdDocsDocument;
  candidates: TdDocsCandidate[];
  warnings: TdDocsWarning[];
  source: TdDocsSource;
  installed_corpus_build?: string;
  cache: TdDocsCacheStatus;
}

export interface TdDocsProvenance {
  source?: TdDocsSource;
  source_path?: string;
  source_url?: string;
  installed_corpus_build?: string;
  running_td_build?: string;
  build_relation: TdDocsBuildRelation;
  cache: TdDocsCacheStatus;
  sources_attempted: TdDocsSource[];
}

export interface TdDocsOutput {
  status: TdDocsStatus;
  query: string;
  kind_requested: TdDocsKind;
  page?: TdDocsPageIdentity;
  content?: string;
  content_chars: number;
  content_truncated: boolean;
  sections_available: TdDocsSection[];
  sections_truncated: boolean;
  selected_section?: TdDocsSection;
  candidates: TdDocsCandidate[];
  provenance: TdDocsProvenance;
  warnings: TdDocsWarning[];
}
