import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTdmcpServer } from "../../src/server/tdmcpServer.js";
import { coreProfileToolNames } from "../../src/tools/registry.js";
import { loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer } from "../helpers/tdMock.js";

const mock = makeTdServer();
beforeAll(() => mock.listen({ onUnhandledFrame: "bypass" }));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

async function connectClient(env: NodeJS.ProcessEnv = {}) {
  const server = createTdmcpServer(loadConfig({ TDMCP_BUILD_LOG: "off", ...env }), {
    logger: silentLogger,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tdmcp-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const CORE = { TDMCP_TOOL_PROFILE: "core" };

type TextContent = Array<{ type: string; text?: string }>;

function structured<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name);
}

describe("integration: TDMCP_TOOL_PROFILE=core", () => {
  it("lists exactly the allowlist, every name a real tool", async () => {
    const listed = await toolNames(await connectClient(CORE));
    expect([...listed].sort()).toEqual([...coreProfileToolNames()].sort());
  });

  it("is a fraction of the full tool list", async () => {
    const size = async (env: NodeJS.ProcessEnv) =>
      JSON.stringify((await (await connectClient(env)).listTools()).tools).length;
    const [core, full] = await Promise.all([size(CORE), size({ TDMCP_TOOL_PROFILE: "full" })]);
    expect(core).toBeLessThan(full * 0.2);
  });

  it("refuses a hidden tool until find_tool enables it, and notifies the client", async () => {
    const client = await connectClient(CORE);
    const notified = vi.fn();
    client.setNotificationHandler(ToolListChangedNotificationSchema, notified);

    const search = await client.callTool({
      name: "find_tool",
      arguments: { query: "kaleidoscope" },
    });
    const { matches } = structured<{ matches: Array<{ name: string; enabled: boolean }> }>(search);
    const match = matches.find((tool) => tool.name === "create_kaleidoscope");
    expect(match?.enabled).toBe(false);
    expect(await toolNames(client)).not.toContain("create_kaleidoscope");

    const before = await client
      .callTool({ name: "create_kaleidoscope", arguments: {} })
      .catch((err: Error) => ({ isError: true, content: [{ type: "text", text: err.message }] }));
    expect(before.isError).toBe(true);
    expect((before.content as TextContent)[0]?.text).toMatch(/disabled/i);

    await client.callTool({ name: "find_tool", arguments: { enable: ["create_kaleidoscope"] } });
    expect(await toolNames(client)).toContain("create_kaleidoscope");
    await vi.waitFor(() => expect(notified).toHaveBeenCalled());
  });

  it("leaves the default and directory surfaces as they were", async () => {
    const full = await toolNames(await connectClient());
    expect(full).toContain("create_kaleidoscope");
    expect(full).toContain("find_tool");

    const directory = await toolNames(await connectClient({ TDMCP_TOOL_PROFILE: "directory" }));
    expect(directory).not.toContain("find_tool");
  });

  it("cannot reach a tool the safe policy removed", async () => {
    const client = await connectClient({ TDMCP_TOOL_PROFILE: "safe" });
    const result = await client.callTool({
      name: "find_tool",
      arguments: { enable: ["execute_python_script"] },
    });
    expect(structured<{ unknown: string[] }>(result).unknown).toEqual(["execute_python_script"]);
    expect(await toolNames(client)).not.toContain("execute_python_script");
  });

  it("cannot enable raw Python when it is off", async () => {
    const client = await connectClient({ ...CORE, TDMCP_RAW_PYTHON: "off" });
    const result = await client.callTool({
      name: "find_tool",
      arguments: { enable: ["execute_python_script"] },
    });
    expect(structured<{ unknown: string[] }>(result).unknown).toEqual(["execute_python_script"]);
  });
});

describe("integration: build attribution", () => {
  it("records which registered tool produced a build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-build-attr-"));
    try {
      const client = await connectClient({ TDMCP_BUILD_LOG: "on", TDMCP_BUILD_LOG_DIR: dir });
      const result = await client.callTool({
        name: "create_feedback_network",
        arguments: { parent_path: "/project1" },
      });
      expect(result.isError).toBeFalsy();

      const [line] = readFileSync(join(dir, "builds.jsonl"), "utf8").split("\n");
      const record = JSON.parse(line ?? "{}") as {
        tool?: string;
        args?: { parent_path?: string };
        nodes?: unknown[];
      };
      expect(record.tool).toBe("create_feedback_network");
      expect(record.args?.parent_path).toBe("/project1");
      expect(record.nodes?.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
