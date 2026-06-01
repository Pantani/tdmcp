import { describe, expect, it, vi } from "vitest";
import {
  applyChatFlagOverrides,
  CREATIVE_CHAT_TEMPERATURE,
  parseChatArgs,
  runChat,
} from "../../src/cli/chat.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import type { ChatMessage, LlmClient, OpenAITool } from "../../src/llm/client.js";
import { resolveRequestedTier } from "../../src/llm/server.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { DEFAULT_LLM_TEMPERATURE, loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";

const makeCtx = (): ToolContext => ({
  client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:9", timeoutMs: 500 }),
  knowledge: new KnowledgeBase(),
  recipes: new RecipeLibrary(),
  logger: silentLogger,
});

function answeringClient(answer: string, seen: { tools?: string[]; messages?: ChatMessage[] }) {
  return {
    health: vi.fn(async () => ({ ok: true, modelReady: true, detail: "ready" })),
    chatStream: vi.fn(async (messages: ChatMessage[], tools: OpenAITool[]) => {
      seen.messages = messages;
      seen.tools = tools.map((tool) => tool.function.name);
      return { role: "assistant", content: answer };
    }),
  } as unknown as LlmClient;
}

describe("tdmcp chat CLI flags", () => {
  it("parses read-only, creative, prompt, and config selection flags", () => {
    const opts = parseChatArgs([
      "--read-only",
      "--creative",
      "--prompt",
      "Inspect /project1",
      "--no-ollama",
      "--profile",
      "club",
      "--config",
      "/tmp/tdmcp.json",
    ]);

    expect(opts.readOnly).toBe(true);
    expect(opts.creative).toBe(true);
    expect(opts.prompt).toBe("Inspect /project1");
    expect(opts.autoStartOllama).toBe(false);
    expect(opts.profile).toBe("club");
    expect(opts.configPath).toBe("/tmp/tdmcp.json");
  });

  it("maps --creative to the creative tier and a more creative temperature", () => {
    const base = loadConfig({});
    const config = applyChatFlagOverrides(base, parseChatArgs(["--creative"]));

    expect(config.llmTier).toBe("creative");
    expect(config.llmTemperature).toBeGreaterThanOrEqual(CREATIVE_CHAT_TEMPERATURE);
  });

  it("keeps --read-only as the stronger tool-tier constraint", () => {
    const base = loadConfig({ TDMCP_LLM_TIER: "creative", TDMCP_LLM_TEMPERATURE: "1.1" });
    const config = applyChatFlagOverrides(base, parseChatArgs(["--read-only", "--creative"]));

    expect(config.llmTier).toBe("safe");
    expect(config.llmTemperature).toBe(1.1);
  });

  it("lets a locked read-only server tier override browser-requested tiers", () => {
    expect(resolveRequestedTier("creative", "standard", "safe")).toBe("safe");
    expect(resolveRequestedTier("standard", "creative", "safe")).toBe("safe");
  });

  it("runs --prompt headlessly without starting the chat server or opening a browser", async () => {
    const seen: { tools?: string[]; messages?: ChatMessage[] } = {};
    const server = vi.fn();
    const browser = vi.fn();
    const ensure = vi.fn(async () => true);
    let stdout = "";

    await runChat(["--prompt", "What is in /project1?", "--read-only", "--no-ollama"], {
      loadConfig: () => loadConfig({}),
      createLogger: () => silentLogger,
      buildToolContext: () => makeCtx(),
      createClient: () => answeringClient("Only inspection tools are enabled.", seen),
      startChatServer: server,
      openBrowser: browser,
      ensureOllamaUp: ensure,
      writeStdout: (chunk) => {
        stdout += chunk;
      },
    });

    expect(server).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledWith(
      expect.anything(),
      "http://127.0.0.1:11434/v1",
      false,
      expect.any(Function),
    );
    expect(stdout).toBe("Only inspection tools are enabled.\n");
    expect(seen.messages?.some((message) => message.role === "user")).toBe(true);
    expect(seen.tools).toContain("get_td_nodes");
    expect(seen.tools).not.toContain("create_td_node");
    expect(seen.tools).not.toContain("create_feedback_network");
  });

  it("loads config files and profiles before a headless prompt", async () => {
    const seen: { tools?: string[]; messages?: ChatMessage[] } = {};
    const seenLoadOptions: unknown[] = [];
    const ensure = vi.fn(async () => true);
    let stdout = "";

    await runChat(
      [
        "--prompt",
        "Use the venue model",
        "--config",
        "/tmp/venue.json",
        "--profile",
        "club",
        "--no-ollama",
      ],
      {
        loadConfig: (_env, opts) => {
          seenLoadOptions.push(opts);
          return {
            ...loadConfig({}),
            llmBaseUrl: "http://llm.local/v1",
            llmModel: "club-model",
          };
        },
        createLogger: () => silentLogger,
        buildToolContext: () => makeCtx(),
        createClient: (config) => {
          expect(config.llmBaseUrl).toBe("http://llm.local/v1");
          expect(config.llmModel).toBe("club-model");
          return answeringClient("Loaded venue config.", seen);
        },
        ensureOllamaUp: ensure,
        writeStdout: (chunk) => {
          stdout += chunk;
        },
      },
    );

    expect(seenLoadOptions[0]).toMatchObject({
      useFiles: true,
      configPath: "/tmp/venue.json",
      profile: "club",
    });
    expect(ensure).toHaveBeenCalledWith(
      expect.anything(),
      "http://llm.local/v1",
      false,
      expect.any(Function),
    );
    expect(stdout).toBe("Loaded venue config.\n");
    expect(seen.messages?.some((message) => message.content === "Use the venue model")).toBe(true);
  });

  it("prints the default temperature when the runtime config omits one", async () => {
    const ensure = vi.fn(async () => true);
    const close = vi.fn(async () => {});
    let stdout = "";

    const run = runChat(["--no-open", "--no-ollama"], {
      loadConfig: () =>
        ({
          ...loadConfig({}),
          llmTemperature: undefined,
        }) as unknown as ReturnType<typeof loadConfig>,
      createLogger: () => silentLogger,
      buildToolContext: () => makeCtx(),
      createClient: () =>
        ({
          health: vi.fn(async () => ({ ok: true, modelReady: true, detail: "ready" })),
        }) as unknown as LlmClient,
      startChatServer: vi.fn(async () => ({
        url: "http://127.0.0.1:4141",
        port: 4141,
        close,
      })),
      ensureOllamaUp: ensure,
      writeStdout: (chunk) => {
        stdout += chunk;
      },
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (stdout.includes(`temperature: ${DEFAULT_LLM_TEMPERATURE}`)) break;
      await Promise.resolve();
    }
    expect(stdout).toContain(`temperature: ${DEFAULT_LLM_TEMPERATURE}`);
    process.emit("SIGINT");
    await run;

    expect(close).toHaveBeenCalledOnce();
  });
});
