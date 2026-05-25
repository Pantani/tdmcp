import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Logger, silentLogger } from "../utils/logger.js";
import { bottobotPackageDir, knowledgeDataDir } from "../utils/paths.js";
import {
  compactKey,
  normalizeGlsl,
  normalizePatterns,
  slugify,
  toOperatorSummary,
  toPythonSummary,
  toTutorialSummary,
} from "./normalize.js";
import type {
  GlslSummary,
  GlslTechnique,
  KnowledgeStats,
  OperatorDoc,
  OperatorSummary,
  Pattern,
  PatternSummary,
  PythonClass,
  PythonClassSummary,
  Tutorial,
  TutorialSummary,
} from "./types.js";

export interface KnowledgeBaseOptions {
  dataDir?: string;
  logger?: Logger;
}

interface ResolvedSource {
  kind: "local" | "bottobot" | "empty";
  operatorsDir: string;
  operatorsIndex?: string;
  pythonDir: string;
  tutorialsDir: string;
  patternsFile: string;
  glslFile: string;
}

const EMPTY_SOURCE: ResolvedSource = {
  kind: "empty",
  operatorsDir: "",
  pythonDir: "",
  tutorialsDir: "",
  patternsFile: "",
  glslFile: "",
};

/**
 * Read-only accessor over the embedded TouchDesigner knowledge base. Prefers the
 * imported local data directory; falls back to reading directly from an installed
 * `@bottobot/td-mcp`; otherwise degrades to empty results (never throws on lookup).
 */
export class KnowledgeBase {
  private readonly logger: Logger;
  private readonly source: ResolvedSource;

  private opIndexCache?: OperatorSummary[];
  private opLookupCache?: Map<string, string>;
  private readonly opDocCache = new Map<string, OperatorDoc | null>();
  private pyIndexCache?: PythonClassSummary[];
  private pyLookupCache?: Map<string, string>;
  private readonly pyDocCache = new Map<string, PythonClass | null>();
  private tutIndexCache?: TutorialSummary[];
  private tutLookupCache?: Map<string, string>;
  private readonly tutDocCache = new Map<string, Tutorial | null>();
  private patternsCache?: Pattern[];
  private glslCache?: GlslTechnique[];

  constructor(options: KnowledgeBaseOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this.source = KnowledgeBase.resolveSource(options.dataDir ?? knowledgeDataDir());
    this.logger.debug("knowledge source resolved", { kind: this.source.kind });
  }

  private static resolveSource(localDir: string): ResolvedSource {
    if (existsSync(join(localDir, "operators"))) {
      return {
        kind: "local",
        operatorsDir: join(localDir, "operators"),
        operatorsIndex: join(localDir, "operators", "index.json"),
        pythonDir: join(localDir, "python-api"),
        tutorialsDir: join(localDir, "tutorials"),
        patternsFile: join(localDir, "patterns.json"),
        glslFile: join(localDir, "glsl.json"),
      };
    }
    const bb = bottobotPackageDir();
    if (bb) {
      return {
        kind: "bottobot",
        operatorsDir: join(bb, "wiki/data/processed"),
        pythonDir: join(bb, "wiki/data/python-api"),
        tutorialsDir: join(bb, "wiki/data/tutorials"),
        patternsFile: join(bb, "data/patterns.json"),
        glslFile: join(bb, "wiki/data/experimental/glsl.json"),
      };
    }
    return EMPTY_SOURCE;
  }

  private readJson(path: string): unknown {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      this.logger.debug("knowledge readJson failed", { path, error: String(err) });
      return undefined;
    }
  }

  private listJsonFiles(dir: string): string[] {
    if (!dir || !existsSync(dir)) return [];
    try {
      return readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
    } catch {
      return [];
    }
  }

  // ---- Operators -----------------------------------------------------------

  private operatorIndex(): OperatorSummary[] {
    if (this.opIndexCache) return this.opIndexCache;
    if (this.source.kind === "empty") {
      this.opIndexCache = [];
      return this.opIndexCache;
    }
    if (this.source.operatorsIndex && existsSync(this.source.operatorsIndex)) {
      const data = this.readJson(this.source.operatorsIndex);
      if (Array.isArray(data)) {
        this.opIndexCache = data as OperatorSummary[];
        return this.opIndexCache;
      }
    }
    const summaries: OperatorSummary[] = [];
    for (const file of this.listJsonFiles(this.source.operatorsDir)) {
      const doc = this.readJson(join(this.source.operatorsDir, file)) as OperatorDoc | undefined;
      if (doc?.name) summaries.push(toOperatorSummary(file.replace(/\.json$/, ""), doc));
    }
    this.opIndexCache = summaries;
    return this.opIndexCache;
  }

  private operatorLookup(): Map<string, string> {
    if (this.opLookupCache) return this.opLookupCache;
    const map = new Map<string, string>();
    for (const summary of this.operatorIndex()) {
      map.set(compactKey(summary.slug), summary.slug);
      map.set(compactKey(summary.name), summary.slug);
      map.set(compactKey(summary.displayName), summary.slug);
    }
    this.opLookupCache = map;
    return map;
  }

  listOperatorCategories(): string[] {
    const set = new Set<string>();
    for (const summary of this.operatorIndex()) set.add(summary.category);
    return [...set].sort();
  }

  listOperators(category?: string): OperatorSummary[] {
    const all = this.operatorIndex();
    if (!category) return all;
    const wanted = compactKey(category);
    return all.filter((s) => compactKey(s.category) === wanted);
  }

  getOperator(nameOrSlug: string): OperatorDoc | undefined {
    if (this.source.kind === "empty") return undefined;
    const slug = this.operatorLookup().get(compactKey(nameOrSlug)) ?? slugify(nameOrSlug);
    const cached = this.opDocCache.get(slug);
    if (cached !== undefined) return cached ?? undefined;
    const file = join(this.source.operatorsDir, `${slug}.json`);
    const doc = existsSync(file) ? (this.readJson(file) as OperatorDoc | undefined) : undefined;
    this.opDocCache.set(slug, doc ?? null);
    return doc;
  }

  /** Soft existence check (by operator type, display name, or slug). */
  operatorExists(typeOrName: string): boolean {
    return this.operatorLookup().has(compactKey(typeOrName));
  }

  searchOperators(query: string, limit = 25): OperatorSummary[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/);
    const scored: Array<{ summary: OperatorSummary; score: number }> = [];
    for (const summary of this.operatorIndex()) {
      const haystack =
        `${summary.name} ${summary.displayName} ${summary.summary} ${summary.keywords.join(" ")}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += 1;
        if (summary.name.toLowerCase().includes(term)) score += 1;
      }
      if (score > 0) scored.push({ summary, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.summary);
  }

  // ---- Python API ----------------------------------------------------------

  private pythonIndex(): PythonClassSummary[] {
    if (this.pyIndexCache) return this.pyIndexCache;
    if (this.source.kind === "empty") {
      this.pyIndexCache = [];
      return this.pyIndexCache;
    }
    const indexPath = join(this.source.pythonDir, "index.json");
    if (existsSync(indexPath)) {
      const data = this.readJson(indexPath);
      if (Array.isArray(data)) {
        this.pyIndexCache = data as PythonClassSummary[];
        return this.pyIndexCache;
      }
    }
    const summaries: PythonClassSummary[] = [];
    for (const file of this.listJsonFiles(this.source.pythonDir)) {
      const cls = this.readJson(join(this.source.pythonDir, file)) as PythonClass | undefined;
      if (cls?.className) summaries.push(toPythonSummary(cls));
    }
    this.pyIndexCache = summaries;
    return this.pyIndexCache;
  }

  private pythonLookup(): Map<string, string> {
    if (this.pyLookupCache) return this.pyLookupCache;
    const map = new Map<string, string>();
    for (const summary of this.pythonIndex()) {
      map.set(compactKey(summary.className), summary.className);
      map.set(compactKey(summary.displayName), summary.className);
    }
    this.pyLookupCache = map;
    return map;
  }

  listPythonClasses(): PythonClassSummary[] {
    return this.pythonIndex();
  }

  getPythonClass(name: string): PythonClass | undefined {
    if (this.source.kind === "empty") return undefined;
    const className = this.pythonLookup().get(compactKey(name)) ?? name;
    const cached = this.pyDocCache.get(className);
    if (cached !== undefined) return cached ?? undefined;
    const file = join(this.source.pythonDir, `${className}.json`);
    const cls = existsSync(file) ? (this.readJson(file) as PythonClass | undefined) : undefined;
    this.pyDocCache.set(className, cls ?? null);
    return cls;
  }

  // ---- Patterns ------------------------------------------------------------

  private patterns(): Pattern[] {
    if (this.patternsCache) return this.patternsCache;
    if (this.source.kind === "empty") {
      this.patternsCache = [];
      return this.patternsCache;
    }
    const data = this.readJson(this.source.patternsFile);
    if (Array.isArray(data) && data.length > 0 && typeof (data[0] as Pattern).id === "string") {
      this.patternsCache = data as Pattern[];
    } else {
      this.patternsCache = normalizePatterns(data);
    }
    return this.patternsCache;
  }

  listPatterns(): PatternSummary[] {
    return this.patterns().map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category ?? "Unknown",
      description: p.description ?? "",
    }));
  }

  getPattern(name: string): Pattern | undefined {
    const key = compactKey(name);
    return this.patterns().find((p) => compactKey(p.id) === key || compactKey(p.name) === key);
  }

  // ---- GLSL ----------------------------------------------------------------

  private glsl(): GlslTechnique[] {
    if (this.glslCache) return this.glslCache;
    if (this.source.kind === "empty") {
      this.glslCache = [];
      return this.glslCache;
    }
    const data = this.readJson(this.source.glslFile);
    this.glslCache = Array.isArray(data) ? (data as GlslTechnique[]) : normalizeGlsl(data);
    return this.glslCache;
  }

  listGlslPatterns(): GlslSummary[] {
    return this.glsl().map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description ?? "",
      difficulty: g.difficulty ?? "unknown",
    }));
  }

  getGlslPattern(name: string): GlslTechnique | undefined {
    const key = compactKey(name);
    return this.glsl().find((g) => compactKey(g.id) === key || compactKey(g.name) === key);
  }

  // ---- Tutorials -----------------------------------------------------------

  private tutorialIndex(): TutorialSummary[] {
    if (this.tutIndexCache) return this.tutIndexCache;
    if (this.source.kind === "empty") {
      this.tutIndexCache = [];
      return this.tutIndexCache;
    }
    const indexPath = join(this.source.tutorialsDir, "index.json");
    if (existsSync(indexPath)) {
      const data = this.readJson(indexPath);
      if (Array.isArray(data)) {
        this.tutIndexCache = data as TutorialSummary[];
        return this.tutIndexCache;
      }
    }
    const summaries: TutorialSummary[] = [];
    for (const file of this.listJsonFiles(this.source.tutorialsDir)) {
      const tut = this.readJson(join(this.source.tutorialsDir, file)) as Tutorial | undefined;
      if (tut?.id || tut?.name) {
        const normalized: Tutorial = {
          ...tut,
          id: tut.id ?? file.replace(/\.json$/, ""),
          name: tut.name ?? file,
        };
        summaries.push(toTutorialSummary(normalized));
      }
    }
    this.tutIndexCache = summaries;
    return this.tutIndexCache;
  }

  private tutorialLookup(): Map<string, string> {
    if (this.tutLookupCache) return this.tutLookupCache;
    const map = new Map<string, string>();
    for (const file of this.listJsonFiles(this.source.tutorialsDir)) {
      const slug = file.replace(/\.json$/, "");
      map.set(compactKey(slug), slug);
    }
    for (const summary of this.tutorialIndex()) {
      map.set(compactKey(summary.id), summary.id);
      map.set(compactKey(summary.name), summary.id);
    }
    this.tutLookupCache = map;
    return map;
  }

  listTutorials(): TutorialSummary[] {
    return this.tutorialIndex();
  }

  getTutorial(name: string): Tutorial | undefined {
    if (this.source.kind === "empty") return undefined;
    const slug = this.tutorialLookup().get(compactKey(name)) ?? slugify(name);
    const cached = this.tutDocCache.get(slug);
    if (cached !== undefined) return cached ?? undefined;
    const file = join(this.source.tutorialsDir, `${slug}.json`);
    const tut = existsSync(file) ? (this.readJson(file) as Tutorial | undefined) : undefined;
    this.tutDocCache.set(slug, tut ?? null);
    return tut;
  }

  // ---- Meta ----------------------------------------------------------------

  get sourceKind(): KnowledgeStats["source"] {
    return this.source.kind;
  }

  stats(): KnowledgeStats {
    return {
      source: this.source.kind,
      operators: this.operatorIndex().length,
      pythonClasses: this.pythonIndex().length,
      patterns: this.patterns().length,
      glsl: this.glsl().length,
      tutorials: this.tutorialIndex().length,
    };
  }
}
