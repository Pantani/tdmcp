import { KnowledgeBase } from "../knowledge/index.js";
import { RecipeLibrary } from "../recipes/loader.js";
import type { ToolContext } from "../tools/types.js";
import type { TdmcpConfig } from "../utils/config.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { Vault } from "../vault/index.js";
import { ConnectionManager } from "./connectionManager.js";

export interface ToolContextOverrides {
  logger?: Logger;
  knowledge?: KnowledgeBase;
  recipes?: RecipeLibrary;
  connection?: ConnectionManager;
  vault?: Vault;
}

/**
 * Assembles the shared {@link ToolContext} that backs every tool handler. Both
 * the MCP server and the agent CLI build their context here, so the two surfaces
 * stay on the same core (client + knowledge + recipes) without duplicating wiring.
 */
export function buildToolContext(
  config: TdmcpConfig,
  overrides: ToolContextOverrides = {},
): ToolContext {
  const logger = overrides.logger ?? createLogger(config.logLevel);
  const connection = overrides.connection ?? new ConnectionManager(config, logger);
  const knowledge = overrides.knowledge ?? new KnowledgeBase({ logger });
  const vault =
    overrides.vault ?? (config.vaultPath ? new Vault(config.vaultPath, logger) : undefined);
  const recipes = overrides.recipes ?? new RecipeLibrary({ logger, vault });
  return {
    client: connection.client,
    knowledge,
    recipes,
    logger,
    vault,
    allowRawPython: config.rawPython !== "off",
  };
}
