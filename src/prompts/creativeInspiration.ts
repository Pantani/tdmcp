import { z } from "zod";
import type { CreativeRagCard } from "../creativeRag/types.js";
import { type PromptContext, type PromptRegistrar, userPrompt } from "./types.js";

export const creativeInspirationSchema = {
  theme: z.string().describe("Free-text mood/concept (e.g. 'underwater cathedral, slow, blue')."),
  k: z.string().optional().describe("Number of cards to return (1–10). Defaults to 5."),
  tools_hint: z
    .string()
    .optional()
    .describe("Comma-separated Layer 1 tool names the user is steering toward."),
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function parseK(raw: string | undefined): number {
  const parsed = parseInt(raw ?? "5", 10);
  return clamp(Number.isNaN(parsed) ? 5 : parsed, 1, 10);
}

function tagline(card: CreativeRagCard): string {
  if (card.visualLanguage) {
    return card.visualLanguage.length > 140
      ? `${card.visualLanguage.slice(0, 137)}...`
      : card.visualLanguage;
  }
  if (card.body) {
    const firstLine = card.body.split("\n").find((l) => l.trim().length > 0) ?? "";
    return firstLine.length > 140 ? `${firstLine.slice(0, 137)}...` : firstLine;
  }
  return "";
}

/** Pure async impl — no bridge; unit-testable with a mocked ctx. */
export async function creativeInspirationImpl(
  ctx: PromptContext,
  args: { theme: string; k?: string; tools_hint?: string },
): Promise<ReturnType<typeof userPrompt>> {
  const { theme, k, tools_hint } = args;

  if (
    !("creativeRag" in ctx) ||
    (ctx as unknown as { creativeRag?: unknown }).creativeRag == null
  ) {
    return userPrompt(
      `Creative RAG is not enabled on this tdmcp server, so no mood board cards are available. ` +
        `Enable it by setting \`TDMCP_CREATIVE_RAG_ENABLED=1\` and running ` +
        `\`tdmcp creative sync && tdmcp creative index\`. ` +
        `Then re-run this prompt with the same theme. ` +
        `Meanwhile, proceed with the requested theme using the model's own visual knowledge: ${theme}.`,
    );
  }

  const ragCtx = ctx as PromptContext & {
    creativeRag: {
      search: (
        q: string,
        k: number,
      ) => Promise<Array<{ id: string; score: number; title: string }>>;
      getCard: (id: string) => Promise<CreativeRagCard | undefined>;
    };
  };

  const kNum = parseK(k);

  let results: Array<{ id: string; score: number; title: string }>;
  try {
    results = await ragCtx.creativeRag.search(theme, kNum);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return userPrompt(
      `Creative RAG search failed (${msg}). ` +
        `Proceed with the requested theme using the model's own visual knowledge: ${theme}.`,
    );
  }

  if (results.length === 0) {
    return userPrompt(
      `No Creative RAG cards matched the theme "${theme}". ` +
        `Try running \`tdmcp creative sync\` to add more sources, then \`tdmcp creative index\` to re-embed. ` +
        `Meanwhile, proceed with the requested theme using the model's own visual knowledge: ${theme}.`,
    );
  }

  const lines: string[] = [];

  for (const result of results) {
    const card = await ragCtx.creativeRag.getCard(result.id);
    if (card == null) continue;
    const tl = tagline(card);
    const entry = tl
      ? `- ${card.title} — ${tl} — tdmcp://creative/cards/${card.id}`
      : `- ${card.title} — tdmcp://creative/cards/${card.id}`;
    lines.push(entry);
  }

  // Every getCard returned null → same fallback as empty search instead of
  // emitting an empty `## Mood board` block (which would be a misleading
  // success — the model would think no cards were available).
  if (lines.length === 0) {
    return userPrompt(
      `No Creative RAG cards matched the theme "${theme}". ` +
        `Try running \`tdmcp creative sync\` to add more sources, then \`tdmcp creative index\` to re-embed. ` +
        `Meanwhile, proceed with the requested theme using the model's own visual knowledge: ${theme}.`,
    );
  }

  const header = tools_hint
    ? `Create a TouchDesigner visual for the theme: ${theme}.\nPrefer these Layer 1 tools: ${tools_hint}.`
    : `Create a TouchDesigner visual for the theme: ${theme}.`;

  const footer =
    "Open each card resource with the MCP `read_resource` capability to see the full card " +
    "(image, palette, tags). Use them as visual reference, then build the network with the most " +
    "appropriate Layer 1 tool (e.g. create_audio_reactive, create_feedback_network, " +
    "create_particle_system, create_kaleidoscope). Keep palette and motion cues consistent " +
    "with the mood board.";

  const text = [header, "", "## Mood board", ...lines, "", footer].join("\n");

  return userPrompt(text);
}

export const registerCreativeInspiration: PromptRegistrar = (server, ctx) => {
  server.registerPrompt(
    "creative_inspiration",
    {
      title: "Creative inspiration (mood board)",
      description:
        "Runs a Creative RAG search and returns a mood board of curated reference cards " +
        "as a prompt payload ready for any Layer 1 TD-building tool.",
      argsSchema: creativeInspirationSchema,
    },
    (args) => {
      // Disabled-branch shortcut: keep sync so the prompt-eval harness (which
      // does not await handlers) can render the fallback text. Only the
      // RAG-enabled path is async.
      if (!ctx.creativeRag) {
        return userPrompt(
          `Creative RAG is not enabled on this tdmcp server, so no mood board cards are available. ` +
            `Enable it by setting \`TDMCP_CREATIVE_RAG_ENABLED=1\` and running ` +
            `\`tdmcp creative sync && tdmcp creative index\`. ` +
            `Then re-run this prompt with the same theme. ` +
            `Meanwhile, proceed with the requested theme using the model's own visual knowledge: ${args.theme}.`,
        );
      }
      return creativeInspirationImpl(ctx, args);
    },
  );
};
