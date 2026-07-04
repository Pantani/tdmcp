import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  KnowledgeDataVersion,
  KnowledgeStats,
  OperatorCodeExample,
  OperatorConnectionEntry,
  OperatorConnectionsGuide,
  OperatorDoc,
  OperatorExamplesGuide,
  OperatorSummary,
  OperatorWorkflowHit,
  OperatorWorkflowSuggestion,
  Pattern,
  PatternSummary,
  PythonClass,
  PythonClassSummary,
  TdExperimentalBuildSeries,
  TdExperimentalBuilds,
  TdOperatorCompatibility,
  TdOperatorCompatibilityIndex,
  TdPythonApiCompatibilityClass,
  TdPythonApiCompatibilityEntry,
  TdPythonApiCompatibilityIndex,
  TdReleaseHighlight,
  TdReleaseHighlights,
  TdVersionInfo,
  TdVersionManifest,
  TechniquePackSummary,
  TechniqueSearchSummary,
  TouchDesignerClassReference,
  TouchDesignerClassSummary,
  TouchDesignerTechnique,
  TouchDesignerTechniquePack,
  Tutorial,
  TutorialSummary,
} from "./types.js";

type OperatorIdentity = Pick<OperatorSummary, "slug" | "name" | "displayName" | "category">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function connectionEntries(value: unknown): OperatorConnectionEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => ({
      op: optionalString(entry.op) ?? optionalString(entry.operator) ?? "",
      port: optionalString(entry.port),
      reason: optionalString(entry.reason),
    }))
    .filter((entry) => entry.op);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function codeExamples(value: unknown): OperatorCodeExample[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry, index) => ({
      title: optionalString(entry.title) ?? `Example ${index + 1}`,
      language: optionalString(entry.language),
      code: optionalString(entry.code) ?? optionalString(entry.snippet) ?? "",
      description: optionalString(entry.description),
    }))
    .filter((entry) => entry.code);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function operatorTypeToken(identity: OperatorIdentity): string {
  const family = identity.category.toUpperCase();
  const familySuffix = escapeRegExp(family);
  const shortName = identity.displayName
    .replace(new RegExp(`\\s+${familySuffix}$`, "i"), "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toLowerCase();
  return `${shortName}${family}`;
}

function operatorStepMatches(step: string, identity: OperatorIdentity): boolean {
  const stepKey = compactKey(step);
  const categorySuffix = escapeRegExp(identity.category);
  const names = [
    identity.name,
    identity.displayName,
    identity.slug,
    identity.displayName.replace(new RegExp(`\\s+${categorySuffix}$`, "i"), ""),
    identity.name.replace(new RegExp(`\\s+${categorySuffix}$`, "i"), ""),
  ];
  return names.some((name) => compactKey(name) === stepKey);
}

function inferSuggestionComplexity(operator: string): OperatorWorkflowSuggestion["complexity"] {
  const key = operator.toLowerCase();
  if (key.includes("glsl") || key.includes("script") || key.includes("render")) return "complex";
  if (key.includes("feedback") || key.includes("geometry") || key.includes("particle")) {
    return "medium";
  }
  return "simple";
}

function suggestionNodeRange(
  complexity: OperatorWorkflowSuggestion["complexity"],
): OperatorWorkflowSuggestion["estimatedNodes"] {
  if (complexity === "complex") return "12-25";
  if (complexity === "medium") return "6-12";
  return "3-6";
}

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
  versionsDir: string;
  techniquesDir: string;
  tdClassesDir: string;
}

const EMPTY_SOURCE: ResolvedSource = {
  kind: "empty",
  operatorsDir: "",
  pythonDir: "",
  tutorialsDir: "",
  patternsFile: "",
  glslFile: "",
  versionsDir: "",
  techniquesDir: "",
  tdClassesDir: "",
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
  private dataVersionCache?: KnowledgeDataVersion | null;
  private readonly opDocCache = new Map<string, OperatorDoc | null>();
  private pyIndexCache?: PythonClassSummary[];
  private pyLookupCache?: Map<string, string>;
  private readonly pyDocCache = new Map<string, PythonClass | null>();
  private tutIndexCache?: TutorialSummary[];
  private tutLookupCache?: Map<string, string>;
  private readonly tutDocCache = new Map<string, Tutorial | null>();
  private patternsCache?: Pattern[];
  private glslCache?: GlslTechnique[];
  private tdVersionManifestCache?: TdVersionManifest;
  private tdReleaseHighlightsCache?: TdReleaseHighlights;
  private tdOperatorCompatCache?: TdOperatorCompatibilityIndex;
  private tdPythonApiCompatCache?: TdPythonApiCompatibilityIndex;
  private tdExperimentalBuildsCache?: TdExperimentalBuilds;
  private techniquePackCache?: TouchDesignerTechniquePack[];
  private tdClassCache?: TouchDesignerClassReference[];

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
        versionsDir: join(localDir, "versions"),
        techniquesDir: join(localDir, "techniques"),
        tdClassesDir: join(localDir, "td-classes"),
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
        versionsDir: join(bb, "wiki/data/versions"),
        techniquesDir: join(bb, "wiki/data/experimental"),
        tdClassesDir: join(bb, "wiki/data/classes"),
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

  private operatorIdentity(nameOrSlug: string, doc: OperatorDoc): OperatorIdentity {
    const key = compactKey(nameOrSlug);
    const summary = this.operatorIndex().find((entry) =>
      [entry.slug, entry.name, entry.displayName].some(
        (candidate) => compactKey(candidate) === key,
      ),
    );
    return {
      slug: summary?.slug ?? slugify(doc.name),
      name: doc.name,
      displayName: doc.displayName ?? doc.name,
      category: doc.category ?? summary?.category ?? "Unknown",
    };
  }

  private operatorWorkflowHits(identity: OperatorIdentity): OperatorWorkflowHit[] {
    const hits: OperatorWorkflowHit[] = [];
    for (const pattern of this.patterns()) {
      const workflow = Array.isArray(pattern.workflow)
        ? pattern.workflow.filter((step): step is string => typeof step === "string")
        : [];
      const position = workflow.findIndex((step) => operatorStepMatches(step, identity));
      if (position === -1) continue;
      hits.push({
        patternId: pattern.id,
        patternName: pattern.name,
        category: pattern.category,
        useCase: pattern.use_case,
        workflow,
        position,
        previousOperator: workflow[position - 1],
        nextOperator: workflow[position + 1],
      });
    }
    return hits;
  }

  getOperatorConnections(nameOrSlug: string): OperatorConnectionsGuide | undefined {
    const doc = this.getOperator(nameOrSlug);
    if (!doc) return undefined;
    const identity = this.operatorIdentity(nameOrSlug, doc);
    return {
      operator: identity,
      inputs: connectionEntries(doc.commonInputs),
      outputs: connectionEntries(doc.commonOutputs),
      relatedOperators: stringArray(doc.relatedOperators),
      workflowPatterns: stringArray(doc.workflowPatterns),
      workflowHits: this.operatorWorkflowHits(identity),
      usage: doc.usage,
      notes: doc.tips?.[0],
    };
  }

  suggestNextOperators(nameOrSlug: string, limit = 10): OperatorWorkflowSuggestion[] {
    const guide = this.getOperatorConnections(nameOrSlug);
    if (!guide) return [];
    const suggestions = new Map<string, OperatorWorkflowSuggestion>();
    const addSuggestion = (suggestion: OperatorWorkflowSuggestion) => {
      const key = compactKey(suggestion.operator);
      const existing = suggestions.get(key);
      if (!existing || suggestion.confidence > existing.confidence)
        suggestions.set(key, suggestion);
    };

    for (const output of guide.outputs) {
      const complexity = inferSuggestionComplexity(output.op);
      addSuggestion({
        operator: output.op,
        reason: output.reason ?? "Common downstream operator",
        confidence: 0.9,
        source: "commonOutput",
        portHint: output.port ?? "output 0 -> input 0",
        complexity,
        estimatedNodes: suggestionNodeRange(complexity),
        minVersion: output.op.toUpperCase().includes("POP") ? "2022" : "2019",
      });
    }

    for (const hit of guide.workflowHits) {
      if (!hit.nextOperator) continue;
      const complexity = inferSuggestionComplexity(hit.nextOperator);
      addSuggestion({
        operator: hit.nextOperator,
        reason: `Next operator in ${hit.patternName}`,
        confidence: 0.8,
        source: "workflowPattern",
        portHint: "output 0 -> input 0",
        complexity,
        estimatedNodes: suggestionNodeRange(complexity),
        minVersion: hit.nextOperator.toUpperCase().includes("POP") ? "2022" : "2019",
        patternId: hit.patternId,
        useCase: hit.useCase,
      });
    }

    for (const related of guide.relatedOperators) {
      const complexity = inferSuggestionComplexity(related);
      addSuggestion({
        operator: related,
        reason: "Related operator from documentation",
        confidence: 0.5,
        source: "relatedOperator",
        complexity,
        estimatedNodes: suggestionNodeRange(complexity),
        minVersion: related.toUpperCase().includes("POP") ? "2022" : "2019",
      });
    }

    return [...suggestions.values()].sort((a, b) => b.confidence - a.confidence).slice(0, limit);
  }

  private generatedOperatorUsagePatterns(identity: OperatorIdentity): OperatorCodeExample[] {
    const categorySuffix = escapeRegExp(identity.category);
    const shortName = identity.displayName
      .replace(new RegExp(`\\s+${categorySuffix}$`, "i"), "")
      .replace(/\s+/g, "")
      .toLowerCase();
    const typeToken = operatorTypeToken(identity);
    const examples: OperatorCodeExample[] = [
      {
        title: `Create or reference ${identity.displayName}`,
        language: "python",
        code: [
          `existing = op('${shortName}1')`,
          "parent = op('/project1')",
          `created = parent.create(${typeToken})`,
          `created.name = '${shortName}1'`,
        ].join("\n"),
        description: `Basic reference and creation pattern for ${identity.displayName}.`,
      },
    ];
    if (identity.category === "CHOP") {
      examples.push({
        title: `Read ${identity.displayName} channel data`,
        language: "python",
        code: [
          `my_op = op('${shortName}1')`,
          "for chan in my_op.chans():",
          "    print(chan.name, chan[0])",
        ].join("\n"),
        description: "Access CHOP channels safely through the operator API.",
      });
    } else if (identity.category === "TOP") {
      examples.push({
        title: `Inspect ${identity.displayName} resolution`,
        language: "python",
        code: [
          `my_op = op('${shortName}1')`,
          "print(my_op.width, my_op.height)",
          "my_op.save('output.png')",
        ].join("\n"),
        description: "Inspect TOP dimensions or save a rendered image.",
      });
    }
    return examples;
  }

  getOperatorExamples(nameOrSlug: string): OperatorExamplesGuide | undefined {
    const doc = this.getOperator(nameOrSlug);
    if (!doc) return undefined;
    const identity = this.operatorIdentity(nameOrSlug, doc);
    return {
      operator: identity,
      pythonExamples: codeExamples(doc.pythonExamples),
      codeExamples: codeExamples(doc.codeExamples),
      expressions: codeExamples(doc.expressions),
      usagePatterns: this.generatedOperatorUsagePatterns(identity),
      usage: doc.usage,
      tips: doc.tips ?? [],
    };
  }

  searchOperatorConnectionGuides(
    query: string,
    limit = 10,
  ): Array<{ id: string; name: string; description?: string }> {
    return this.searchOperators(query, limit).map((operator) => ({
      id: operator.slug,
      name: operator.displayName,
      description: operator.summary,
    }));
  }

  searchOperatorExampleGuides(
    query: string,
    limit = 10,
  ): Array<{ id: string; name: string; description?: string }> {
    return this.searchOperatorConnectionGuides(query, limit);
  }

  private opHaystackCache?: Array<{
    summary: OperatorSummary;
    haystack: string;
    nameLower: string;
  }>;

  private operatorHaystacks(): Array<{
    summary: OperatorSummary;
    haystack: string;
    nameLower: string;
  }> {
    if (this.opHaystackCache) return this.opHaystackCache;
    this.opHaystackCache = this.operatorIndex().map((summary) => ({
      summary,
      haystack:
        `${summary.name} ${summary.displayName} ${summary.summary} ${summary.keywords.join(" ")}`.toLowerCase(),
      nameLower: summary.name.toLowerCase(),
    }));
    return this.opHaystackCache;
  }

  searchOperators(query: string, limit = 25): OperatorSummary[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/);
    const scored: Array<{ summary: OperatorSummary; score: number }> = [];
    for (const entry of this.operatorHaystacks()) {
      let score = 0;
      for (const term of terms) {
        if (entry.haystack.includes(term)) score += 1;
        if (entry.nameLower.includes(term)) score += 1;
      }
      if (score > 0) scored.push({ summary: entry.summary, score });
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

  // ---- Technique packs ------------------------------------------------------

  private techniquePacks(): TouchDesignerTechniquePack[] {
    if (this.techniquePackCache) return this.techniquePackCache;
    if (this.source.kind === "empty" || !this.source.techniquesDir) {
      this.techniquePackCache = [];
      return this.techniquePackCache;
    }
    const packs: TouchDesignerTechniquePack[] = [];
    for (const file of this.listJsonFiles(this.source.techniquesDir)) {
      const data = this.readJson(join(this.source.techniquesDir, file));
      if (!isRecord(data) || !Array.isArray(data.techniques)) continue;
      const id = optionalString(data.category) ?? file.replace(/\.json$/, "");
      packs.push({
        category: id,
        displayName: optionalString(data.displayName) ?? id,
        description: optionalString(data.description),
        versionRequirement: optionalString(data.versionRequirement),
        techniques: data.techniques as TouchDesignerTechnique[],
        resources: data.resources,
      });
    }
    this.techniquePackCache = packs.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return this.techniquePackCache;
  }

  listTechniquePacks(): TechniquePackSummary[] {
    return this.techniquePacks().map((pack) => ({
      id: pack.category,
      name: pack.displayName,
      description: pack.description,
      count: pack.techniques.length,
    }));
  }

  getTechniquePack(category: string): TouchDesignerTechniquePack | undefined {
    const key = compactKey(category);
    return this.techniquePacks().find((pack) =>
      [pack.category, pack.displayName, pack.category.replace(/-/g, " ")].some(
        (alias) => compactKey(alias) === key,
      ),
    );
  }

  getTechnique(category: string, techniqueId?: string): TouchDesignerTechnique | undefined {
    const pack = this.getTechniquePack(category);
    if (!pack) return undefined;
    if (!techniqueId) return pack.techniques[0];
    const key = compactKey(techniqueId);
    return pack.techniques.find((technique) =>
      [technique.id, technique.name].some((alias) => compactKey(alias) === key),
    );
  }

  searchTechniques(query: string, limit = 10): TechniqueSearchSummary[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const results: TechniqueSearchSummary[] = [];
    for (const pack of this.techniquePacks()) {
      const packText =
        `${pack.category} ${pack.displayName} ${pack.description ?? ""}`.toLowerCase();
      if (terms.length === 0 || terms.every((term) => packText.includes(term))) {
        results.push({
          id: pack.category,
          name: pack.displayName,
          description: pack.description,
        });
      }
      for (const technique of pack.techniques) {
        const text = `${pack.category} ${pack.displayName} ${technique.id} ${technique.name} ${
          technique.description ?? ""
        } ${technique.operators?.join(" ") ?? ""} ${technique.tags?.join(" ") ?? ""}`.toLowerCase();
        if (terms.length > 0 && !terms.every((term) => text.includes(term))) continue;
        results.push({
          id: `${pack.category}/${technique.id}`,
          name: technique.name,
          description: technique.description,
        });
      }
      if (results.length >= limit) break;
    }
    return results.slice(0, limit);
  }

  // ---- TD class references --------------------------------------------------

  private tdClasses(): TouchDesignerClassReference[] {
    if (this.tdClassCache) return this.tdClassCache;
    if (this.source.kind === "empty" || !this.source.tdClassesDir) {
      this.tdClassCache = [];
      return this.tdClassCache;
    }
    const classes: TouchDesignerClassReference[] = [];
    for (const file of this.listJsonFiles(this.source.tdClassesDir)) {
      const data = this.readJson(join(this.source.tdClassesDir, file));
      if (!isRecord(data)) continue;
      const id = optionalString(data.id) ?? file.replace(/\.json$/, "");
      const name = optionalString(data.name) ?? optionalString(data.displayName) ?? id;
      classes.push({
        id,
        name,
        displayName: optionalString(data.displayName),
        category: optionalString(data.category),
        subcategory: optionalString(data.subcategory),
        type: optionalString(data.type),
        description: optionalString(data.description),
        summary: optionalString(data.summary),
        url: optionalString(data.url),
        usage: optionalString(data.usage),
        tips: stringArray(data.tips),
        warnings: stringArray(data.warnings),
        relatedOperators: stringArray(data.relatedOperators),
        workflowPatterns: stringArray(data.workflowPatterns),
        keywords: stringArray(data.keywords),
        tags: stringArray(data.tags),
      });
    }
    this.tdClassCache = classes.sort((a, b) => a.name.localeCompare(b.name));
    return this.tdClassCache;
  }

  listTouchDesignerClasses(): TouchDesignerClassSummary[] {
    return this.tdClasses().map((entry) => ({
      id: entry.id,
      name: entry.displayName ?? entry.name,
      description: entry.summary ?? entry.description,
    }));
  }

  getTouchDesignerClass(family: string): TouchDesignerClassReference | undefined {
    const key = compactKey(family);
    return this.tdClasses().find((entry) => {
      const display = entry.displayName ?? entry.name;
      const familyName = display.replace(/\s+Class$/i, "");
      return [entry.id, entry.name, display, familyName, `${familyName} Class`].some(
        (alias) => compactKey(alias) === key,
      );
    });
  }

  searchTouchDesignerClasses(query: string, limit = 10): TouchDesignerClassSummary[] {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.listTouchDesignerClasses()
      .filter((entry) => {
        if (terms.length === 0) return true;
        const text = `${entry.id} ${entry.name} ${entry.description ?? ""}`.toLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .slice(0, limit);
  }

  // ---- TouchDesigner versions / compatibility ------------------------------

  private readVersionJson(filename: string): unknown {
    if (this.source.kind === "empty" || !this.source.versionsDir) return undefined;
    return this.readJson(join(this.source.versionsDir, filename));
  }

  private tdVersionManifest(): TdVersionManifest {
    if (this.tdVersionManifestCache) return this.tdVersionManifestCache;
    const data = this.readVersionJson("version-manifest.json") as Partial<TdVersionManifest>;
    this.tdVersionManifestCache = {
      schemaVersion: data?.schemaVersion,
      description: data?.description,
      versions: Array.isArray(data?.versions) ? data.versions : [],
      versionOrder: Array.isArray(data?.versionOrder) ? data.versionOrder : undefined,
      currentStable: typeof data?.currentStable === "string" ? data.currentStable : undefined,
      pythonVersionMap:
        data?.pythonVersionMap && typeof data.pythonVersionMap === "object"
          ? data.pythonVersionMap
          : undefined,
    };
    return this.tdVersionManifestCache;
  }

  listTdVersions(): TdVersionInfo[] {
    const manifest = this.tdVersionManifest();
    const order = manifest.versionOrder ?? [];
    if (order.length === 0) return manifest.versions;
    const byId = new Map(manifest.versions.map((version) => [version.id, version]));
    return order.map((id) => byId.get(id)).filter((v): v is TdVersionInfo => Boolean(v));
  }

  /** The newest TouchDesigner version the knowledge base knows about (by major, then id). */
  newestTdVersion(): TdVersionInfo | undefined {
    const versions = this.listTdVersions();
    if (versions.length === 0) return undefined;
    return versions.reduce((best, current) => {
      const bestMajor = best.majorVersion ?? 0;
      const curMajor = current.majorVersion ?? 0;
      if (curMajor > bestMajor) return current;
      if (curMajor === bestMajor && (current.id ?? "") > (best.id ?? "")) return current;
      return best;
    });
  }

  /**
   * Provenance of the offline knowledge base — which importer/version generated it,
   * when, and the newest TouchDesigner build it reflects — so a tool can stamp
   * results with a `data_version` and warn when a live TD is on a different major.
   */
  dataVersion(): KnowledgeDataVersion | undefined {
    if (this.dataVersionCache !== undefined) return this.dataVersionCache ?? undefined;
    this.dataVersionCache = this.readDataVersion() ?? null;
    return this.dataVersionCache ?? undefined;
  }

  private readDataVersion(): KnowledgeDataVersion | undefined {
    if (this.source.kind === "empty") return undefined;
    const metaPath = join(dirname(this.source.operatorsDir), "meta.json");
    if (!existsSync(metaPath)) return undefined;
    const meta = this.readJson(metaPath) as Record<string, unknown> | undefined;
    if (!meta) return undefined;
    const newest = this.newestTdVersion();
    return {
      source: typeof meta.source === "string" ? meta.source : "unknown",
      sourceVersion: typeof meta.bottobotVersion === "string" ? meta.bottobotVersion : undefined,
      importedAt: typeof meta.importedAt === "string" ? meta.importedAt : undefined,
      tdVersion: newest?.id,
      tdMajor: newest?.majorVersion,
    };
  }

  getTdVersion(versionOrAlias: string): TdVersionInfo | undefined {
    const raw = versionOrAlias.trim();
    const directKey = compactKey(raw);
    const embedded = raw.match(/\b(099|99|20\d{2})\b/)?.[1];
    const compactEmbedded = directKey.match(/^(?:td|touchdesigner)?(099|99|20\d{2})$/)?.[1];
    const lookupKeys = new Set([
      directKey,
      compactKey(embedded ?? ""),
      compactKey(compactEmbedded ?? ""),
    ]);
    if (lookupKeys.has("99")) lookupKeys.add("099");

    return this.listTdVersions().find((version) => {
      const aliases = [
        version.id,
        version.label,
        version.majorVersion ? String(version.majorVersion) : "",
        `td ${version.id}`,
        `td${version.id}`,
        `TouchDesigner ${version.id}`,
        version.majorVersion ? `TouchDesigner ${version.majorVersion}` : "",
      ];
      return aliases.some((alias) => alias && lookupKeys.has(compactKey(alias)));
    });
  }

  listStableVersions(): TdVersionInfo[] {
    return this.listTdVersions();
  }

  getVersion(versionOrAlias: string): TdVersionInfo | undefined {
    return this.getTdVersion(versionOrAlias);
  }

  getVersionManifest(): TdVersionManifest {
    return this.tdVersionManifest();
  }

  getCurrentStableTdVersion(): TdVersionInfo | undefined {
    const current = this.tdVersionManifest().currentStable;
    return current ? this.getTdVersion(current) : this.listTdVersions().at(-1);
  }

  private tdReleaseHighlights(): TdReleaseHighlights {
    if (this.tdReleaseHighlightsCache) return this.tdReleaseHighlightsCache;
    const data = this.readVersionJson("release-highlights.json") as Partial<TdReleaseHighlights>;
    this.tdReleaseHighlightsCache = {
      schemaVersion: data?.schemaVersion,
      description: data?.description,
      releases: data?.releases && typeof data.releases === "object" ? data.releases : {},
    };
    return this.tdReleaseHighlightsCache;
  }

  getTdReleaseHighlight(versionOrAlias: string): TdReleaseHighlight | undefined {
    const version = this.getTdVersion(versionOrAlias);
    if (!version) return undefined;
    return this.tdReleaseHighlights().releases[version.id];
  }

  getReleaseHighlights(versionOrAlias: string): TdReleaseHighlight | undefined {
    return this.getTdReleaseHighlight(versionOrAlias);
  }

  getReleaseHighlightsData(): TdReleaseHighlights {
    return this.tdReleaseHighlights();
  }

  private tdOperatorCompatibility(): TdOperatorCompatibilityIndex {
    if (this.tdOperatorCompatCache) return this.tdOperatorCompatCache;
    const data = this.readVersionJson(
      "operator-compatibility.json",
    ) as Partial<TdOperatorCompatibilityIndex>;
    this.tdOperatorCompatCache = {
      schemaVersion: data?.schemaVersion,
      description: data?.description,
      operators: data?.operators && typeof data.operators === "object" ? data.operators : {},
    };
    return this.tdOperatorCompatCache;
  }

  listOperatorCompatibility(): TdOperatorCompatibility[] {
    return Object.values(this.tdOperatorCompatibility().operators);
  }

  getOperatorCompatibilityData(): TdOperatorCompatibilityIndex {
    return this.tdOperatorCompatibility();
  }

  getOperatorCompatibility(operator: string): TdOperatorCompatibility | undefined {
    const key = compactKey(operator);
    for (const [slug, record] of Object.entries(this.tdOperatorCompatibility().operators)) {
      if (compactKey(slug) === key || compactKey(record.name) === key) return record;
    }
    const slug = slugify(operator);
    return this.tdOperatorCompatibility().operators[slug];
  }

  searchOperatorCompatibility(
    query: string,
    limit = 10,
  ): Array<{ id: string; name: string; description?: string }> {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches: Array<{ id: string; name: string; description?: string }> = [];
    for (const [id, record] of Object.entries(this.tdOperatorCompatibility().operators)) {
      const changes = (record.changedIn ?? [])
        .map((change) => `${change.version} ${change.change}`)
        .join(" ");
      const text =
        `${id} ${record.name} ${record.category ?? ""} ${record.addedIn ?? ""} ${record.removedIn ?? ""} ${changes} ${record.notes ?? ""}`.toLowerCase();
      if (terms.length > 0 && !terms.every((term) => text.includes(term))) continue;
      matches.push({ id, name: record.name, description: record.notes });
      if (matches.length >= limit) break;
    }
    return matches;
  }

  private tdPythonApiCompatibility(): TdPythonApiCompatibilityIndex {
    if (this.tdPythonApiCompatCache) return this.tdPythonApiCompatCache;
    const data = this.readVersionJson(
      "python-api-compatibility.json",
    ) as Partial<TdPythonApiCompatibilityIndex>;
    this.tdPythonApiCompatCache = {
      schemaVersion: data?.schemaVersion,
      description: data?.description,
      classes: data?.classes && typeof data.classes === "object" ? data.classes : {},
    };
    return this.tdPythonApiCompatCache;
  }

  getPythonApiCompatibility(ref: `${string}.${string}`): TdPythonApiCompatibilityEntry | undefined;
  getPythonApiCompatibility(ref: string): TdPythonApiCompatibilityClass | undefined;
  getPythonApiCompatibility(
    ref: string,
  ): TdPythonApiCompatibilityClass | TdPythonApiCompatibilityEntry | undefined {
    const [classRef, memberRef] = ref.split(".");
    if (!classRef) return undefined;
    const classKey = Object.keys(this.tdPythonApiCompatibility().classes).find(
      (name) => compactKey(name) === compactKey(classRef),
    );
    if (!classKey) return undefined;
    const cls = this.tdPythonApiCompatibility().classes[classKey];
    if (!cls) return undefined;
    if (!memberRef) return cls;
    const methodName = Object.keys(cls.methods ?? {}).find(
      (name) => compactKey(name) === compactKey(memberRef),
    );
    if (methodName) {
      const method = cls.methods?.[methodName];
      if (!method) return undefined;
      return {
        class: classKey,
        name: methodName,
        kind: "method",
        ...method,
      };
    }
    const memberName = Object.keys(cls.members ?? {}).find(
      (name) => compactKey(name) === compactKey(memberRef),
    );
    if (!memberName) return undefined;
    const member = cls.members?.[memberName];
    if (!member) return undefined;
    return {
      class: classKey,
      name: memberName,
      kind: "member",
      ...member,
    };
  }

  getPythonApiCompatibilityData(): TdPythonApiCompatibilityIndex {
    return this.tdPythonApiCompatibility();
  }

  searchPythonApiCompatibility(
    query: string,
    limit = 10,
  ): Array<{ id: string; name: string; description?: string }> {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches: Array<{ id: string; name: string; description?: string }> = [];
    const pushIfMatch = (id: string, description?: string) => {
      const text = `${id} ${description ?? ""}`.toLowerCase();
      if (terms.length > 0 && !terms.every((term) => text.includes(term))) return;
      matches.push({ id, name: id, description });
    };

    for (const [className, cls] of Object.entries(this.tdPythonApiCompatibility().classes)) {
      pushIfMatch(className, cls.description);
      for (const [methodName, entry] of Object.entries(cls.methods ?? {})) {
        pushIfMatch(`${className}.${methodName}`, entry.description);
      }
      for (const [memberName, entry] of Object.entries(cls.members ?? {})) {
        pushIfMatch(`${className}.${memberName}`, entry.description);
      }
      if (matches.length >= limit) break;
    }
    return matches.slice(0, limit);
  }

  private tdExperimentalBuilds(): TdExperimentalBuilds {
    if (this.tdExperimentalBuildsCache) return this.tdExperimentalBuildsCache;
    const data = this.readVersionJson("experimental-builds.json") as Partial<TdExperimentalBuilds>;
    this.tdExperimentalBuildsCache = {
      schemaVersion: data?.schemaVersion,
      description: data?.description,
      trackInfo: data?.trackInfo && typeof data.trackInfo === "object" ? data.trackInfo : undefined,
      currentExperimentalSeries:
        typeof data?.currentExperimentalSeries === "string"
          ? data.currentExperimentalSeries
          : undefined,
      buildSeries: Array.isArray(data?.buildSeries) ? data.buildSeries : [],
    };
    return this.tdExperimentalBuildsCache;
  }

  listExperimentalBuildSeries(): TdExperimentalBuildSeries[] {
    return this.tdExperimentalBuilds().buildSeries;
  }

  getExperimentalBuildData(): TdExperimentalBuilds {
    return this.tdExperimentalBuilds();
  }

  getExperimentalBuildSeries(seriesId?: string): TdExperimentalBuildSeries | undefined {
    const wanted = seriesId ?? this.tdExperimentalBuilds().currentExperimentalSeries;
    if (!wanted) return this.listExperimentalBuildSeries()[0];
    const key = compactKey(wanted);
    return this.listExperimentalBuildSeries().find(
      (series) => compactKey(series.seriesId) === key || compactKey(series.label).includes(key),
    );
  }

  getTdVersionOperatorChanges(versionOrAlias: string): TdOperatorCompatibility[] {
    const version = this.getTdVersion(versionOrAlias);
    if (!version) return [];
    return this.listOperatorCompatibility().filter((record) =>
      record.changedIn?.some((change) => change.version === version.id),
    );
  }

  getTdVersionNewOperators(versionOrAlias: string): TdOperatorCompatibility[] {
    const version = this.getTdVersion(versionOrAlias);
    if (!version) return [];
    return this.listOperatorCompatibility().filter((record) => record.addedIn === version.id);
  }

  getTdVersionPythonApiAdditions(versionOrAlias: string): TdPythonApiCompatibilityEntry[] {
    const version = this.getTdVersion(versionOrAlias);
    if (!version) return [];
    const additions: TdPythonApiCompatibilityEntry[] = [];
    for (const [className, cls] of Object.entries(this.tdPythonApiCompatibility().classes)) {
      for (const [name, entry] of Object.entries(cls.methods ?? {})) {
        if (entry.addedIn === version.id) {
          additions.push({ class: className, name, kind: "method", ...entry });
        }
      }
      for (const [name, entry] of Object.entries(cls.members ?? {})) {
        if (entry.addedIn === version.id) {
          additions.push({ class: className, name, kind: "member", ...entry });
        }
      }
    }
    return additions;
  }

  listTouchDesignerVersions(): Array<{
    version: string;
    name: string;
    releaseDate?: string;
    stability?: string;
    summary?: string;
  }> {
    return this.listTdVersions().map((version) => ({
      version: version.id,
      name: version.label,
      releaseDate:
        typeof version.releaseYear === "number" ? String(version.releaseYear) : undefined,
      stability: version.supportStatus,
      summary: version.notes,
    }));
  }

  getTouchDesignerVersion(versionOrAlias: string):
    | {
        version: TdVersionInfo;
        releaseHighlights?: TdReleaseHighlight;
        newOperators: TdOperatorCompatibility[];
        operatorChanges: TdOperatorCompatibility[];
        pythonApiAdditions: TdPythonApiCompatibilityEntry[];
      }
    | undefined {
    const version = this.getTdVersion(versionOrAlias);
    if (!version) return undefined;
    return {
      version,
      releaseHighlights: this.getTdReleaseHighlight(version.id),
      newOperators: this.getTdVersionNewOperators(version.id),
      operatorChanges: this.getTdVersionOperatorChanges(version.id),
      pythonApiAdditions: this.getTdVersionPythonApiAdditions(version.id),
    };
  }

  searchTouchDesignerVersions(
    query: string,
    limit = 10,
  ): Array<{ version: string; name: string; summary?: string }> {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = this.listTouchDesignerVersions();
    if (terms.length === 0) return haystack.slice(0, limit);
    return haystack
      .filter((entry) => {
        const text = `${entry.version} ${entry.name} ${entry.stability ?? ""} ${
          entry.summary ?? ""
        }`.toLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .slice(0, limit);
  }

  listTouchDesignerExperimentals(): Array<{
    id: string;
    name: string;
    description?: string;
    count?: number;
  }> {
    return this.listExperimentalBuildSeries().map((series) => ({
      id: series.seriesId,
      name: series.label,
      description: series.stabilityNotes,
      count: series.experimentalOperators?.length,
    }));
  }

  getTouchDesignerExperimental(seriesOrCategory: string): TdExperimentalBuildSeries | undefined {
    return this.getExperimentalBuildSeries(seriesOrCategory);
  }

  searchTouchDesignerExperimentals(
    query: string,
    limit = 10,
  ): Array<{ id: string; name: string; description?: string }> {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = this.listTouchDesignerExperimentals();
    if (terms.length === 0) return haystack.slice(0, limit);
    return haystack
      .filter((entry) => {
        const text = `${entry.id} ${entry.name} ${entry.description ?? ""}`.toLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .slice(0, limit);
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
      tdVersions: this.listTdVersions().length,
      releaseHighlights: Object.keys(this.tdReleaseHighlights().releases).length,
      operatorCompatibility: Object.keys(this.tdOperatorCompatibility().operators).length,
      pythonApiCompatibility: Object.keys(this.tdPythonApiCompatibility().classes).length,
      experimentalBuildSeries: this.listExperimentalBuildSeries().length,
      techniquePacks: this.listTechniquePacks().length,
      techniques: this.techniquePacks().reduce((total, pack) => total + pack.techniques.length, 0),
      tdClasses: this.listTouchDesignerClasses().length,
    };
  }
}
