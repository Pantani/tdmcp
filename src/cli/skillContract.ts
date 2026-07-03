import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTdmcpServer } from "../server/tdmcpServer.js";
import { loadConfig } from "../utils/config.js";
import { silentLogger } from "../utils/logger.js";
import { getVersion } from "../utils/version.js";

/** One tool in the portable contract: name + human description + JSON-Schema inputs. */
export interface SkillContractTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
}

/**
 * A self-describing, host-agnostic snapshot of tdmcp's tool surface — names,
 * descriptions and JSON-Schema inputs — plus the prompts it exposes. Portable: a
 * different agent framework can read it to know what tdmcp can do without booting the
 * server, and it diffs cleanly across releases.
 */
export interface SkillContract {
  name: string;
  version: string;
  generatedWith: string;
  toolCount: number;
  promptCount: number;
  tools: SkillContractTool[];
  prompts: Array<{ name: string; description?: string }>;
}

/** Builds the contract by listing the live tool registry over an in-memory MCP handshake. */
export async function buildSkillContract(): Promise<SkillContract> {
  const config = loadConfig({}, { useFiles: false });
  const server = createTdmcpServer(config, { logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tdmcp-contract", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const prompts = await client
      .listPrompts()
      .then((r) => r.prompts.map((p) => ({ name: p.name, description: p.description })))
      .catch(() => []);
    const contractTools = tools
      .map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      name: "tdmcp",
      version: getVersion(),
      generatedWith: `tdmcp ${getVersion()}`,
      toolCount: contractTools.length,
      promptCount: prompts.length,
      tools: contractTools,
      prompts: prompts.sort((a, b) => a.name.localeCompare(b.name)),
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Builds the contract and writes it as pretty JSON to `outPath` (creating parents). */
export async function writeSkillContract(outPath: string): Promise<SkillContract> {
  const contract = await buildSkillContract();
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  return contract;
}
