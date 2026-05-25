import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compactKey } from "../knowledge/normalize.js";
import { type Logger, silentLogger } from "../utils/logger.js";
import { recipesDir } from "../utils/paths.js";
import { type Recipe, RecipeSchema, type RecipeSummary } from "./schema.js";

export interface RecipeLibraryOptions {
  dir?: string;
  logger?: Logger;
}

/** Loads and validates recipe JSON files from the recipes directory. */
export class RecipeLibrary {
  private readonly dir: string;
  private readonly logger: Logger;
  private cache?: Recipe[];

  constructor(options: RecipeLibraryOptions = {}) {
    this.dir = options.dir ?? recipesDir();
    this.logger = options.logger ?? silentLogger;
  }

  private load(): Recipe[] {
    if (this.cache) return this.cache;
    const recipes: Recipe[] = [];
    if (existsSync(this.dir)) {
      for (const file of readdirSync(this.dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(readFileSync(join(this.dir, file), "utf8"));
          const parsed = RecipeSchema.safeParse(raw);
          if (parsed.success) {
            recipes.push(parsed.data);
          } else {
            this.logger.warn(`Invalid recipe ${file}`, { issues: parsed.error.issues.length });
          }
        } catch (err) {
          this.logger.warn(`Failed to read recipe ${file}`, { error: String(err) });
        }
      }
    }
    this.cache = recipes;
    return recipes;
  }

  all(): Recipe[] {
    return this.load();
  }

  list(): RecipeSummary[] {
    return this.load().map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      tags: r.tags,
      difficulty: r.difficulty,
    }));
  }

  get(id: string): Recipe | undefined {
    const key = compactKey(id);
    return this.load().find((r) => compactKey(r.id) === key || compactKey(r.name) === key);
  }

  /** Finds the best recipe whose tags/name/description match any of the given terms. */
  findByTags(terms: string[]): Recipe | undefined {
    const wanted = terms.map((t) => t.toLowerCase()).filter(Boolean);
    if (wanted.length === 0) return undefined;
    let best: { recipe: Recipe; score: number } | undefined;
    for (const recipe of this.load()) {
      const haystack =
        `${recipe.name} ${recipe.description} ${recipe.tags.join(" ")}`.toLowerCase();
      let score = 0;
      for (const term of wanted) {
        if (recipe.tags.some((tag) => tag.toLowerCase() === term)) score += 2;
        else if (haystack.includes(term)) score += 1;
      }
      if (score > 0 && (!best || score > best.score)) best = { recipe, score };
    }
    return best?.recipe;
  }
}
