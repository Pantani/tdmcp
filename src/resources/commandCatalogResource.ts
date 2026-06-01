import type { AgentCommandCatalogEntry } from "../cli/agent.js";
import { jsonContents, type ResourceRegistrar } from "./shared.js";

export interface CommandCatalogResource {
  count: number;
  commands: AgentCommandCatalogEntry[];
}

export async function readCommandCatalogResource(): Promise<CommandCatalogResource> {
  const { listAgentCommands } = await import("../cli/agent.js");
  const commands = listAgentCommands();
  return { count: commands.length, commands };
}

export const registerCommandCatalogResource: ResourceRegistrar = (server) => {
  server.registerResource(
    "td-agent-commands",
    "tdmcp://commands",
    {
      title: "tdmcp-agent command catalog",
      description:
        "The command-line verbs exposed by tdmcp-agent, generated from the actual CLI dispatcher so agent clients can discover safe, mutating and unsafe commands without drift.",
      mimeType: "application/json",
    },
    async (uri) => jsonContents(uri, await readCommandCatalogResource()),
  );
};
