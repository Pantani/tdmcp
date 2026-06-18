import { z } from "zod";
import type { ProjectRagLicense, ProjectSearchResult } from "../projectRag/types.js";
import { type PromptContext, type PromptRegistrar, userPrompt } from "./types.js";

export const projectRagContextSchema = {
  query: z
    .string()
    .describe("Free-text description of the effect/idea (e.g. 'audio-reactive feedback tunnel')."),
  k: z.string().optional().describe("Number of cards to return (1–10). Defaults to 5."),
  license: z.string().optional().describe("CSV license filter (e.g. 'CC0,MIT,Apache-2.0')."),
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function parseK(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "5", 10);
  return clamp(Number.isNaN(parsed) ? 5 : parsed, 1, 10);
}

function parseLicenseFilter(raw: string | undefined): ProjectRagLicense[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as ProjectRagLicense[];
  return list.length > 0 ? list : undefined;
}

function tagline(result: ProjectSearchResult): string {
  const notes = result.rightsNotes?.trim();
  if (notes && notes.length > 0) {
    return notes.length > 140 ? `${notes.slice(0, 137)}...` : notes;
  }
  return "";
}

function disabledText(query: string): string {
  return (
    "Project RAG is not enabled on this tdmcp server, so no local project cards are available. " +
    "Enable it by setting `TDMCP_PROJECT_RAG_ENABLED=1` and running " +
    "`tdmcp project-rag sync && tdmcp project-rag index`. " +
    "Then re-run this prompt with the same query. " +
    `Meanwhile, proceed with the request using the model's own knowledge: ${query}.`
  );
}

/** Pure async impl — no bridge; unit-testable with a mocked ctx. */
export async function projectRagContextImpl(
  ctx: PromptContext,
  args: { query: string; k?: string; license?: string },
): Promise<ReturnType<typeof userPrompt>> {
  const { query, k, license } = args;

  if (!("projectRag" in ctx) || (ctx as unknown as { projectRag?: unknown }).projectRag == null) {
    return userPrompt(disabledText(query));
  }

  const ragCtx = ctx as PromptContext & {
    projectRag: {
      search: (
        q: string,
        k: number,
        filters?: { license?: ProjectRagLicense[] },
      ) => Promise<ProjectSearchResult[]>;
    };
  };

  const kNum = parseK(k);
  const licenses = parseLicenseFilter(license);
  const filters = licenses ? { license: licenses } : undefined;

  let results: ProjectSearchResult[];
  try {
    results = await ragCtx.projectRag.search(query, kNum, filters);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return userPrompt(
      `Project RAG search failed (${msg}). ` +
        `Proceed with the request using the model's own knowledge: ${query}.`,
    );
  }

  if (results.length === 0) {
    return userPrompt(
      `No Project RAG cards matched the query "${query}". ` +
        "Try running `tdmcp project-rag sync` to add more sources, then " +
        "`tdmcp project-rag index` to re-embed. " +
        `Meanwhile, proceed with the request using the model's own knowledge: ${query}.`,
    );
  }

  const lines: string[] = [];
  for (const result of results) {
    const tl = tagline(result);
    const entry = tl
      ? `- ${result.title} [${result.license}] — ${tl} — tdmcp://project/cards/${result.id}`
      : `- ${result.title} [${result.license}] — tdmcp://project/cards/${result.id}`;
    lines.push(entry);
  }

  const header = `Use these local project cards as authoritative reference for: ${query}`;
  const footer =
    "Inspect each card via `read_resource` for the full provenance + binary path. " +
    "Respect each card's license: copyleft sources require derivative work to preserve the license.";

  const text = [header, "", "## Project cards", ...lines, "", footer].join("\n");
  return userPrompt(text);
}

export const registerProjectRagContext: PromptRegistrar = (server, ctx) => {
  server.registerPrompt(
    "project_rag_context",
    {
      title: "Project RAG context (local repertoire)",
      description:
        "Runs a Project RAG search and returns a prompt payload of top-k local project cards " +
        "(with provenance + license) as authoritative reference before coding an effect.",
      argsSchema: projectRagContextSchema,
    },
    (args) => {
      // Disabled-branch shortcut: keep sync so the prompt-eval harness (which
      // does not await handlers) can render the fallback text.
      if (!(ctx as PromptContext & { projectRag?: unknown }).projectRag) {
        return userPrompt(disabledText(args.query));
      }
      return projectRagContextImpl(ctx, args);
    },
  );
};
