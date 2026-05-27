import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compactKey } from "../knowledge/normalize.js";
import { type Logger, silentLogger } from "../utils/logger.js";
import { recipesDir } from "../utils/paths.js";
import type { Vault } from "../vault/index.js";
import { recipeFromMarkdown } from "./markdown.js";
import { type Recipe, RecipeSchema, type RecipeSummary } from "./schema.js";

export interface RecipeLibraryOptions {
  dir?: string;
  logger?: Logger;
  /** Optional Obsidian vault; recipes in `<vault>/Recipes/*.md` are merged in (and override built-ins by id). */
  vault?: Vault;
}

/** Loads and validates recipe JSON files from the recipes directory, plus any vault recipes. */
export class RecipeLibrary {
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly vault?: Vault;
  private cache?: Recipe[];

  constructor(options: RecipeLibraryOptions = {}) {
    this.dir = options.dir ?? recipesDir();
    this.logger = options.logger ?? silentLogger;
    this.vault = options.vault;
  }

  private load(): Recipe[] {
    if (this.cache) return this.cache;
    // Keyed by id so a vault recipe (loaded second) cleanly overrides a built-in.
    const byId = new Map<string, Recipe>();

    if (existsSync(this.dir)) {
      for (const file of readdirSync(this.dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(readFileSync(join(this.dir, file), "utf8"));
          const parsed = RecipeSchema.safeParse(raw);
          if (parsed.success) {
            byId.set(compactKey(parsed.data.id), parsed.data);
          } else {
            this.logger.warn(`Invalid recipe ${file}`, { issues: parsed.error.issues.length });
          }
        } catch (err) {
          this.logger.warn(`Failed to read recipe ${file}`, { error: String(err) });
        }
      }
    }

    if (this.vault) {
      for (const file of this.vault.list("Recipes", ".md")) {
        try {
          const recipe = recipeFromMarkdown(this.vault.read(join("Recipes", file)));
          byId.set(compactKey(recipe.id), recipe);
        } catch (err) {
          this.logger.warn(`Invalid vault recipe ${file}`, { error: String(err) });
        }
      }
    }

    this.cache = [...byId.values()];
    return this.cache;
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
