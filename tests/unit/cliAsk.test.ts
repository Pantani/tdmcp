import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAskArgs, runAsk } from "../../src/cli/ask.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import type { LlmClient } from "../../src/llm/client.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";

const makeCtx = (): ToolContext => ({
  client: new TouchDesignerClient({ baseUrl: "http://127.0.0.1:9", timeoutMs: 500 }),
  knowledge: new KnowledgeBase(),
  recipes: new RecipeLibrary(),
  logger: silentLogger,
});

const stubClient = () =>
  ({
    health: vi.fn(async () => ({ ok: true, modelReady: true, detail: "ready" })),
  }) as unknown as LlmClient;

interface Captured {
  prompt?: string;
  tools?: unknown;
  config?: ReturnType<typeof loadConfig>;
}

function answerTurn(answer: string, captured: Captured, toolNames: string[] = []) {
  return vi.fn(async (_ctx, _client, messages, onEvent, opts) => {
    captured.tools = opts?.tools;
    const userMsg = messages.find((m: { role: string }) => m.role === "user") as
      | { content: string }
      | undefined;
    captured.prompt = userMsg?.content;
    for (const name of toolNames) {
      onEvent?.({ type: "tool", name, status: "done", ok: true, summary: "" });
    }
    onEvent?.({ type: "answer", content: answer });
    return [{ role: "assistant", content: answer }];
  }) as unknown as typeof import("../../src/llm/agent.js").runAgentTurn;
}

describe("parseAskArgs", () => {
  it("parses positional prompt and key flags", () => {
    const opts = parseAskArgs([
      "build",
      "me",
      "a",
      "feedback",
      "tunnel",
      "--json",
      "--tools=off",
      "--model",
      "llama3:8b",
      "--profile",
      "club",
      "--config",
      "/tmp/x.json",
      "--read-only",
      "--no-ollama",
      "--timeout",
      "5000",
    ]);
    expect(opts.prompt).toBe("build me a feedback tunnel");
    expect(opts.json).toBe(true);
    expect(opts.toolsOff).toBe(true);
    expect(opts.model).toBe("llama3:8b");
    expect(opts.profile).toBe("club");
    expect(opts.configPath).toBe("/tmp/x.json");
    expect(opts.readOnly).toBe(true);
    expect(opts.autoStartOllama).toBe(false);
    expect(opts.timeoutMs).toBe(5000);
  });

  it("rejects bad --tools and bad --timeout", () => {
    expect(() => parseAskArgs(["--tools=maybe", "hi"])).toThrow(/tools/);
    expect(() => parseAskArgs(["--timeout", "nope", "hi"])).toThrow(/timeout/);
  });
});

describe("runAsk", () => {
  const origExitCode = process.exitCode;
  beforeEach(() => {
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = origExitCode;
  });

  it("joins positional prompt and stdin with a blank line and prints answer to stdout", async () => {
    const captured: Captured = {};
    let stdout = "";
    let stderr = "";
    await runAsk(["explain", "this"], {
      loadConfig: () => loadConfig({}),
      createLogger: () => silentLogger,
      buildToolContext: () => makeCtx(),
      createClient: () => stubClient(),
      ensureOllamaUp: async () => true,
      runAgentTurn: answerTurn("Here is the explanation.", captured, ["get_td_nodes"]),
      readStdin: async () => "log line A\nlog line B\n",
      isStdinTTY: () => false,
      writeStdout: (c) => {
        stdout += c;
      },
      writeStderr: (c) => {
        stderr += c;
      },
    });
    expect(captured.prompt).toBe("explain this\n\nlog line A\nlog line B");
    expect(stdout).toBe("Here is the explanation.\n");
    expect(stderr).toContain("tdmcp ask");
    expect(process.exitCode).toBe(0);
  });

  it("uses stdin alone when there is no positional prompt", async () => {
    const captured: Captured = {};
    let stdout = "";
    await runAsk([], {
      loadConfig: () => loadConfig({}),
      createLogger: () => silentLogger,
      buildToolContext: () => makeCtx(),
      createClient: () => stubClient(),
      ensureOllamaUp: async () => true,
      runAgentTurn: answerTurn("ok", captured),
      readStdin: async () => "what is a TOP?",
      isStdinTTY: () => false,
      writeStdout: (c) => {
        stdout += c;
      },
      writeStderr: () => {},
    });
    expect(captured.prompt).toBe("what is a TOP?");
    expect(stdout).toBe("ok\n");
  });

  it("exits 2 with help on stderr when no prompt and TTY stdin", async () => {
    let stdout = "";
    let stderr = "";
    await runAsk([], {
      loadConfig: () => loadConfig({}),
      createLogger: () => silentLogger,
      buildToolContext: () => makeCtx(),
      createClient: () => stubClient(),
      runAgentTurn: answerTurn("never called", {}),
      isStdinTTY: () => true,
      writeStdout: (c) => {
        stdout += c;
      },
      writeStderr: (c) => {
        stderr += c;
      },
    });
    expect(stdout).toBe("");
    expect(stderr).toContain("no prompt provided");
    expect(process.exitCode).toBe(2);
  });

  it("passes tools=[] when --tools=off and reports tier=chat", async () => {
    const captured: Captured = {};
    let stdout = "";
    await runAsk(["--tools=off", "--json", "what is a TOP?"], {
      loadConfig: () => loadConfig({}),
      createLogger: () => silentLogger,
      buildToolContext: () => makeCtx(),
      createClient: () => stubClient(),
      ensureOllamaUp: async () => true,
      runAgentTurn: answerTurn("A TOP is…", captured),
      isStdinTTY: () => true,
      writeStdout: (c) => {
        stdout += c;
      },
      writeStderr: () => {},
    });
    expect(captured.tools).toEqual([]);
    const obj = JSON.parse(stdout.trim());
    expect(obj.answer).toBe("A TOP is…");
    expect(obj.tier).toBe("chat");
    expect(obj.toolCalls).toEqual([]);
    expect(typeof obj.durationMs).toBe("number");
  });

  it("--read-only beats --tools=on (tier resolves to safe)", async () => {
    const captured: Captured = {};
    await runAsk(["--read-only", "--tools=on", "--json", "inspect /project1"], {
      loadConfig: () => loadConfig({}),
      createLogger: () => silentLogger,
      buildToolContext: () => makeCtx(),
      createClient: (cfg) => {
        captured.config = cfg;
        return stubClient();
      },
      ensureOllamaUp: async () => true,
      runAgentTurn: answerTurn("ok", captured),
      isStdinTTY: () => true,
      writeStdout: () => {},
      writeStderr: () => {},
    });
    expect(captured.config?.llmTier).toBe("safe");
  });

  it("--model overrides llmModel in the downstream config", async () => {
    const captured: Captured = {};
    await runAsk(["--model", "gpt-x", "hi"], {
      loadConfig: () => loadConfig({}),
      createLogger: () => silentLogger,
      buildToolContext: () => makeCtx(),
      createClient: (cfg) => {
        captured.config = cfg;
        return stubClient();
      },
      ensureOllamaUp: async () => true,
      runAgentTurn: answerTurn("ok", captured),
      isStdinTTY: () => true,
      writeStdout: () => {},
      writeStderr: () => {},
    });
    expect(captured.config?.llmModel).toBe("gpt-x");
  });

  it("emits a JSON error and exits 3 when Ollama is unreachable", async () => {
    let stdout = "";
    await runAsk(["--json", "anything"], {
      loadConfig: () => loadConfig({}),
      createLogger: () => silentLogger,
      buildToolContext: () => makeCtx(),
      createClient: () => stubClient(),
      ensureOllamaUp: async () => false,
      runAgentTurn: answerTurn("never", {}),
      isStdinTTY: () => true,
      writeStdout: (c) => {
        stdout += c;
      },
      writeStderr: () => {},
    });
    const obj = JSON.parse(stdout.trim());
    expect(obj.error).toMatch(/not reachable/);
    expect(process.exitCode).toBe(3);
  });

  it("emits JSON with error and exits 1 when the agent reports an error event", async () => {
    let stdout = "";
    const errTurn = vi.fn(async (_ctx, _c, _m, onEvent) => {
      onEvent?.({ type: "error", message: "model fail" });
      return [];
    }) as unknown as typeof import("../../src/llm/agent.js").runAgentTurn;
    await runAsk(["--json", "x"], {
      loadConfig: () => loadConfig({}),
      createLogger: () => silentLogger,
      buildToolContext: () => makeCtx(),
      createClient: () => stubClient(),
      ensureOllamaUp: async () => true,
      runAgentTurn: errTurn,
      isStdinTTY: () => true,
      writeStdout: (c) => {
        stdout += c;
      },
      writeStderr: () => {},
    });
    const obj = JSON.parse(stdout.trim());
    expect(obj.error).toBe("model fail");
    expect(process.exitCode).toBe(1);
  });

  it("exits 124 on timeout", async () => {
    let stderr = "";
    const hangTurn = vi.fn(
      () => new Promise(() => {}),
    ) as unknown as typeof import("../../src/llm/agent.js").runAgentTurn;
    await runAsk(["--timeout", "5", "stuck"], {
      loadConfig: () => loadConfig({}),
      createLogger: () => silentLogger,
      buildToolContext: () => makeCtx(),
      createClient: () => stubClient(),
      ensureOllamaUp: async () => true,
      runAgentTurn: hangTurn,
      isStdinTTY: () => true,
      writeStdout: () => {},
      writeStderr: (c) => {
        stderr += c;
      },
    });
    expect(process.exitCode).toBe(124);
    expect(stderr).toContain("timeout");
  });

  it("text mode: only the answer hits stdout; progress hits stderr", async () => {
    let stdout = "";
    let stderr = "";
    await runAsk(["hi"], {
      loadConfig: () => loadConfig({}),
      createLogger: () => silentLogger,
      buildToolContext: () => makeCtx(),
      createClient: () => stubClient(),
      ensureOllamaUp: async (_c, _u, _a, log) => {
        log("checking endpoint");
        return true;
      },
      runAgentTurn: answerTurn("hello.", {}),
      isStdinTTY: () => true,
      writeStdout: (c) => {
        stdout += c;
      },
      writeStderr: (c) => {
        stderr += c;
      },
    });
    expect(stdout).toBe("hello.\n");
    expect(stderr).toContain("tdmcp ask");
    expect(stderr).toContain("checking endpoint");
  });
});
