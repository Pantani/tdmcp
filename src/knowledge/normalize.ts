import type {
  GlslTechnique,
  OperatorDoc,
  OperatorSummary,
  Pattern,
  PythonClass,
  PythonClassSummary,
  Tutorial,
  TutorialSummary,
} from "./types.js";

/** Filename-style slug: lowercase, non-alphanumerics collapse to underscores. */
export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Lookup key that unifies "Noise TOP", "noiseTOP" and "noise_top" → "noisetop". */
export function compactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function toOperatorSummary(slug: string, doc: OperatorDoc): OperatorSummary {
  return {
    slug,
    name: doc.name,
    displayName: doc.displayName ?? doc.name,
    category: doc.category ?? "Unknown",
    subcategory: doc.subcategory ?? "",
    summary: doc.summary ?? doc.description ?? "",
    keywords: doc.keywords ?? [],
  };
}

export function toPythonSummary(cls: PythonClass): PythonClassSummary {
  return {
    className: cls.className,
    displayName: cls.displayName ?? cls.className,
    category: cls.category ?? "Unknown",
    methodCount: cls.methods?.length ?? 0,
    memberCount: cls.members?.length ?? 0,
  };
}

export function toTutorialSummary(tut: Tutorial): TutorialSummary {
  return {
    id: tut.id,
    name: tut.name,
    category: tut.category ?? "Unknown",
    summary: tut.summary ?? tut.description ?? "",
  };
}

interface RawPattern {
  name?: string;
  description?: string;
  category?: string;
  workflow?: string[];
  use_case?: string;
}

/**
 * The bottobot patterns file is an object with a `patterns` array (plus extra
 * metadata keys). Normalizes it into a flat, id-keyed array.
 */
export function normalizePatterns(raw: unknown): Pattern[] {
  let list: RawPattern[] = [];
  if (Array.isArray(raw)) {
    list = raw as RawPattern[];
  } else if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.patterns)) {
      list = obj.patterns as RawPattern[];
    } else {
      list = Object.values(obj).filter((v): v is RawPattern => !!v && typeof v === "object");
    }
  }
  return list
    .filter((p) => typeof p.name === "string")
    .map((p) => ({
      id: slugify(p.name as string),
      name: p.name as string,
      description: p.description,
      category: p.category,
      workflow: Array.isArray(p.workflow) ? p.workflow : undefined,
      use_case: p.use_case,
    }));
}

interface RawGlslFile {
  techniques?: unknown;
}

/** Extracts GLSL techniques from bottobot's `experimental/glsl.json`. */
export function normalizeGlsl(raw: unknown): GlslTechnique[] {
  const file = (raw ?? {}) as RawGlslFile;
  const techniques = Array.isArray(file.techniques) ? file.techniques : [];
  return techniques
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => {
      const name = typeof t.name === "string" ? t.name : "Untitled";
      const id = typeof t.id === "string" && t.id.length > 0 ? t.id : slugify(name);
      return {
        id,
        name,
        subcategory: typeof t.subcategory === "string" ? t.subcategory : undefined,
        description: typeof t.description === "string" ? t.description : undefined,
        difficulty: typeof t.difficulty === "string" ? t.difficulty : undefined,
        operators: Array.isArray(t.operators) ? (t.operators as string[]) : undefined,
        tags: Array.isArray(t.tags) ? (t.tags as string[]) : undefined,
        notes: typeof t.notes === "string" ? t.notes : undefined,
        code: (t.code ?? undefined) as GlslTechnique["code"],
        setup: typeof t.setup === "string" ? t.setup : undefined,
      };
    });
}
