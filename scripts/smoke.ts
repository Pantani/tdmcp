/**
 * Offline smoke test — no TouchDesigner required.
 *
 *   npm run smoke
 *
 * Boots the MCP server in-process, connects a real MCP client over an in-memory
 * transport, and checks the whole surface answers a genuine protocol handshake:
 * tools/resources/prompts list, and a read tool degrades to a friendly error while
 * TD is offline (instead of throwing). A fast, deterministic guard that the server
 * still assembles and speaks MCP — complements smoke:live (which needs a running TD).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTdmcpServer } from "../src/server/tdmcpServer.js";
import { loadConfig } from "../src/utils/config.js";
import { silentLogger } from "../src/utils/logger.js";

export interface SmokeReport {
  tools: number;
  resources: number;
  prompts: number;
  hasGetTdInfo: boolean;
  infoDegradesGracefully: boolean;
}

const MIN_TOOLS = 31;

/** Runs the offline handshake and returns a report; throws on a hard protocol failure. */
export async function runSmoke(): Promise<SmokeReport> {
  const config = loadConfig({ TDMCP_TD_HOST: "127.0.0.1", TDMCP_TD_PORT: "59980" }, { useFiles: false });
  const server = createTdmcpServer(config, { logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "tdmcp-smoke", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const resources = await client.listResources().then((r) => r.resources.length).catch(() => 0);
    const prompts = await client.listPrompts().then((r) => r.prompts.length).catch(() => 0);

    // get_td_info is designed to SUCCEED while TD is offline, reporting connected:false
    // (not throw, not isError). That graceful degradation is the invariant we check.
    const info = await client.callTool({ name: "get_td_info", arguments: {} });
    const structured = info.structuredContent as { connected?: boolean } | undefined;
    const text = Array.isArray(info.content)
      ? info.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n")
      : "";
    const infoDegradesGracefully =
      info.isError !== true && (structured?.connected === false || /not reachable/i.test(text));

    return {
      tools: tools.length,
      resources,
      prompts,
      hasGetTdInfo: tools.some((t) => t.name === "get_td_info"),
      infoDegradesGracefully,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Throws with a readable message when the report fails any invariant. */
export function assertSmoke(report: SmokeReport): void {
  const failures: string[] = [];
  if (report.tools < MIN_TOOLS) failures.push(`only ${report.tools} tools (expected ≥ ${MIN_TOOLS})`);
  if (!report.hasGetTdInfo) failures.push("get_td_info not registered");
  if (!report.infoDegradesGracefully) failures.push("get_td_info did not degrade to a friendly error offline");
  if (failures.length) throw new Error(`smoke test failed: ${failures.join("; ")}`);
}

async function main(): Promise<void> {
  const report = await runSmoke();
  assertSmoke(report);
  console.log(
    `[smoke] OK — ${report.tools} tools, ${report.resources} resources, ${report.prompts} prompts; ` +
      "get_td_info degrades gracefully offline.",
  );
}

// Run when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[smoke] FAILED:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
