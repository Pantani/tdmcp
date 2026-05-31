import { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import { type TdmcpConfig, tdBaseUrl } from "../utils/config.js";
import type { Logger } from "../utils/logger.js";

/**
 * Owns the TouchDesigner client and exposes a cheap health probe. The MCP server
 * stays alive whether or not TD is reachable.
 */
export class ConnectionManager {
  readonly client: TouchDesignerClient;

  constructor(config: TdmcpConfig, logger: Logger, fetchImpl?: typeof fetch) {
    this.client = new TouchDesignerClient({
      baseUrl: tdBaseUrl(config),
      timeoutMs: config.requestTimeoutMs,
      token: config.bridgeToken,
      logger,
      fetchImpl,
    });
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.client.getInfo();
      return true;
    } catch {
      return false;
    }
  }
}
