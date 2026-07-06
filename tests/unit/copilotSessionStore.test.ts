import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadCopilotSession,
  resolveSessionPath,
  saveCopilotSession,
} from "../../src/llm/sessionStore.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tdmcp-copilot-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TDMCP_COPILOT_SESSION_PATH;
});

describe("copilot session store", () => {
  it("round-trips transcript + model/tier/temperature", () => {
    const path = join(dir, "s.json");
    saveCopilotSession(path, {
      model: "qwen2.5:7b",
      base_url: "http://127.0.0.1:11434",
      tier: "creative",
      temperature: 0.85,
      messages: [
        { role: "user", content: "make a plexus" },
        { role: "assistant", content: "Done — created /project1/plexus1." },
      ],
    });
    const loaded = loadCopilotSession(path);
    expect(loaded).toBeDefined();
    expect(loaded?.model).toBe("qwen2.5:7b");
    expect(loaded?.tier).toBe("creative");
    expect(loaded?.temperature).toBe(0.85);
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[1]?.role).toBe("assistant");
    expect(loaded?.version).toBe(1);
    expect(typeof loaded?.saved_at).toBe("string");
  });

  it("returns undefined when the session file is absent", () => {
    expect(loadCopilotSession(join(dir, "missing.json"))).toBeUndefined();
  });

  it("throws a descriptive error on a corrupt session file", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{ not json", "utf8");
    expect(() => loadCopilotSession(path)).toThrow(/not valid JSON/);
  });

  it("throws on a schema-invalid session file", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ version: 1, saved_at: 1, messages: "nope" }), "utf8");
    expect(() => loadCopilotSession(path)).toThrow(/malformed/);
  });

  it("resolves the path from the env var when no override is given", () => {
    const envPath = join(dir, "env-session.json");
    process.env.TDMCP_COPILOT_SESSION_PATH = envPath;
    expect(resolveSessionPath()).toBe(envPath);
    expect(resolveSessionPath(join(dir, "override.json"))).toBe(join(dir, "override.json"));
  });
});
