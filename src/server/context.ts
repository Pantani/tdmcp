import {
  type CreativeRagService,
  createCreativeRagService,
  toCreativeRagConfig,
} from "../creativeRag/index.js";
import { KnowledgeBase } from "../knowledge/index.js";
import {
  createProjectRagService,
  type ProjectRagService,
  toProjectRagConfig,
} from "../projectRag/index.js";
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
  /** Override the Creative RAG service (tests inject a fake; undefined keeps the config-driven wiring). */
  creativeRag?: CreativeRagService;
  /** Override the Project RAG service (tests inject a fake; undefined keeps the config-driven wiring). */
  projectRag?: ProjectRagService;
  /** Override fetch (used by the fixture-recorder CLI to wrap bridge calls). */
  fetchImpl?: typeof fetch;
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
  const connection =
    overrides.connection ?? new ConnectionManager(config, logger, overrides.fetchImpl);
  const knowledge = overrides.knowledge ?? new KnowledgeBase({ logger });
  const vault =
    overrides.vault ?? (config.vaultPath ? new Vault(config.vaultPath, logger) : undefined);
  const recipes = overrides.recipes ?? new RecipeLibrary({ logger, vault });
  const creativeRag =
    overrides.creativeRag ??
    (config.ragEnabled
      ? createCreativeRagService({ config: toCreativeRagConfig(config), logger })
      : undefined);
  const projectRagConfig = toProjectRagConfig(config);
  const projectRag =
    overrides.projectRag ??
    (projectRagConfig.enabled
      ? createProjectRagService({ config: projectRagConfig, logger })
      : undefined);
  return {
    client: connection.client,
    knowledge,
    recipes,
    logger,
    vault,
    allowRawPython: config.rawPython !== "off",
    toolProfile: config.toolProfile,
    creativeRag,
    projectRag,
  };
}
