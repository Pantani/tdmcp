import type { z } from "zod";
import { registerAllPrompts } from "../prompts/index.js";
import type { PromptContext } from "../prompts/types.js";
import { jsonContents, type ResourceRegistrar } from "./shared.js";

export interface PromptCatalogEntry {
  name: string;
  title: string;
  summary: string;
  args: string[];
}

interface PromptCaptureServer {
  registerPrompt(
    name: string,
    meta: {
      title?: string;
      description?: string;
      argsSchema?: Record<string, z.ZodTypeAny>;
    },
    handler: unknown,
  ): void;
}

export function collectPromptCatalog(ctx: PromptContext): PromptCatalogEntry[] {
  const prompts: PromptCatalogEntry[] = [];
  const capture: PromptCaptureServer = {
    registerPrompt(name, meta) {
      prompts.push({
        name,
        title: meta.title ?? name,
        summary: meta.description ?? "",
        args: Object.keys(meta.argsSchema ?? {}),
      });
    },
  };

  registerAllPrompts(capture as never, ctx);
  return prompts;
}

export const registerPromptCatalogResource: ResourceRegistrar = (server, ctx) => {
  server.registerResource(
    "td-prompts",
    "tdmcp://prompts",
    {
      title: "tdmcp prompt catalog",
      description:
        "The MCP prompts tdmcp offers, generated from the actual prompt registry so clients and local copilot flows do not drift from the registered names.",
      mimeType: "application/json",
    },
    async (uri) => {
      const prompts = collectPromptCatalog(ctx);
      return jsonContents(uri, {
        count: prompts.length,
        note: "Invoke these as MCP prompts. The local `tdmcp chat` copilot can't call them directly, but it can follow the named recipe's intent.",
        prompts,
      });
    },
  );
};
