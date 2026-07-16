import { collectRegisteredPrompts } from "../prompts/registry.js";
import type { PromptContext } from "../prompts/types.js";
import { jsonContents, type ResourceRegistrar } from "./shared.js";

export interface PromptCatalogEntry {
  name: string;
  title: string;
  summary: string;
  args: string[];
}

export function collectPromptCatalog(ctx: PromptContext): PromptCatalogEntry[] {
  return collectRegisteredPrompts(ctx).entries.map(({ descriptor }) => ({
    name: descriptor.name,
    title: descriptor.title,
    summary: descriptor.summary,
    args: [...descriptor.args],
  }));
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
        note: "Invoke these as MCP prompts. The local copilot can render a registered prompt as bounded, untrusted playbook evidence; the active tool tier remains authoritative.",
        prompts,
      });
    },
  );
};
