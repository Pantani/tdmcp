import { KnowledgeBase } from "../src/knowledge/index.js";
import { RecipeLibrary } from "../src/recipes/loader.js";
import { TouchDesignerClient } from "../src/td-client/touchDesignerClient.js";
import { buildFromRecipe } from "../src/tools/layer1/orchestration.js";
import { loadConfig, tdBaseUrl } from "../src/utils/config.js";
import { silentLogger } from "../src/utils/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new TouchDesignerClient({
    baseUrl: tdBaseUrl(config),
    timeoutMs: config.requestTimeoutMs,
    logger: silentLogger,
  });
  const recipes = new RecipeLibrary();
  const recipe = recipes.get("reaction_diffusion");
  if (!recipe) throw new Error("reaction_diffusion recipe not found on disk");

  const ctx = { client, knowledge: new KnowledgeBase(), recipes, logger: silentLogger };
  const { builder } = await buildFromRecipe(ctx, recipe, "/project1");

  console.log("[live] container:", builder.containerPath);
  console.log("[live] created:", builder.created.map((c) => c.path).join(", "));
  console.log("[live] warnings:", JSON.stringify(builder.warnings));

  const glsl1 = builder.pathOf("glsl1");
  if (!glsl1) throw new Error("glsl1 not found in built network");
  const detail = await client.getNode(glsl1);
  const p = detail.parameters as Record<string, unknown>;
  console.log(
    "[live] glsl1 uniforms:",
    JSON.stringify({
      const0name: p.const0name,
      const0value: p.const0value,
      const1name: p.const1name,
      const1value: p.const1value,
    }),
  );

  const errs = await client.getNetworkErrors(builder.containerPath);
  console.log("[live] network errors:", JSON.stringify(errs.errors));
}

main().catch((err) => {
  console.error("[live] FAILED:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
