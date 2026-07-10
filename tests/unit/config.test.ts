import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeConfig,
  listConfigProfiles,
  loadConfig,
  tdBaseUrl,
} from "../../src/utils/config.js";

describe("loadConfig", () => {
  it("falls back to defaults with empty env", () => {
    const config = loadConfig({});
    expect(config.tdHost).toBe("127.0.0.1");
    expect(config.tdPort).toBe(9980);
    expect(config.transport).toBe("stdio");
    expect(config.httpHost).toBeUndefined();
    expect(config.logLevel).toBe("info");
    expect(config.requestTimeoutMs).toBe(10000);
    expect(config.llmTier).toBe("standard");
    expect(config.llmMaxSteps).toBe(8);
    expect(config.llmTemperature).toBe(0.4);
  });

  it("reads overrides and coerces numeric ports", () => {
    const config = loadConfig({
      TDMCP_TD_HOST: "10.0.0.5",
      TDMCP_TD_PORT: "8080",
      TDMCP_HTTP_HOST: "0.0.0.0",
      TDMCP_LOG_LEVEL: "debug",
    });
    expect(config.tdHost).toBe("10.0.0.5");
    expect(config.tdPort).toBe(8080);
    expect(config.httpHost).toBe("0.0.0.0");
    expect(config.logLevel).toBe("debug");
  });

  it("rejects an invalid transport", () => {
    expect(() => loadConfig({ TDMCP_TRANSPORT: "carrier-pigeon" })).toThrow();
  });

  it("defaults cross-RAG fusion knobs and reads overrides", () => {
    const def = loadConfig({});
    expect(def.ragFusion).toBe(false);
    expect(def.ragFusionK).toBe(60);

    const on = loadConfig({ TDMCP_RAG_FUSION: "1", TDMCP_RAG_FUSION_K: "20" });
    expect(on.ragFusion).toBe(true);
    expect(on.ragFusionK).toBe(20);
  });

  it("clamps ragFusionK to its bounds and falls back on non-numeric input", () => {
    expect(loadConfig({ TDMCP_RAG_FUSION_K: "0" }).ragFusionK).toBe(1);
    expect(loadConfig({ TDMCP_RAG_FUSION_K: "5000" }).ragFusionK).toBe(1000);
    expect(loadConfig({ TDMCP_RAG_FUSION_K: "nope" }).ragFusionK).toBe(60);
  });

  it("leaves bridgeToken unset by default and treats empty string as unset", () => {
    expect(loadConfig({}).bridgeToken).toBeUndefined();
    expect(loadConfig({ TDMCP_BRIDGE_TOKEN: "" }).bridgeToken).toBeUndefined();
  });

  it("reads a bridge token from the environment", () => {
    expect(loadConfig({ TDMCP_BRIDGE_TOKEN: "s3cret" }).bridgeToken).toBe("s3cret");
  });

  it("reads local LLM copilot knobs from the environment", () => {
    const config = loadConfig({
      TDMCP_LLM_TIER: " creative ",
      TDMCP_LLM_MAX_STEPS: "12",
      TDMCP_LLM_TEMPERATURE: "0.75",
    });

    expect(config.llmTier).toBe("creative");
    expect(config.llmMaxSteps).toBe(12);
    expect(config.llmTemperature).toBe(0.75);
  });

  it("reads Telegram copilot knobs and keeps Telegram safe by default", () => {
    const defaults = loadConfig({});
    expect(defaults.telegramDefaultTier).toBe("safe");
    expect(defaults.telegramAllowedChats).toEqual([]);
    expect(defaults.telegramAllowedUsers).toEqual([]);

    const config = loadConfig({
      TDMCP_TELEGRAM_BOT_TOKEN: "telegram-secret",
      TDMCP_TELEGRAM_ALLOWED_CHATS: "111, 222",
      TDMCP_TELEGRAM_ALLOWED_USERS: "5,6",
      TDMCP_TELEGRAM_DEFAULT_TIER: "standard",
      TDMCP_TELEGRAM_POLL_TIMEOUT_SEC: "12",
      TDMCP_TELEGRAM_CONFIRM_TIMEOUT_MS: "45000",
    });

    expect(config.telegramBotToken).toBe("telegram-secret");
    expect(config.telegramAllowedChats).toEqual(["111", "222"]);
    expect(config.telegramAllowedUsers).toEqual(["5", "6"]);
    expect(config.telegramDefaultTier).toBe("standard");
    expect(config.telegramPollTimeoutSec).toBe(12);
    expect(config.telegramConfirmTimeoutMs).toBe(45000);
  });

  it("keeps Telegram on the safe tier when its configured tier is invalid", () => {
    expect(loadConfig({ TDMCP_TELEGRAM_DEFAULT_TIER: "unsafe" }).telegramDefaultTier).toBe("safe");
  });

  it("sanitizes local LLM copilot knobs instead of leaking unsafe values", () => {
    expect(loadConfig({ TDMCP_LLM_TIER: "unsafe" }).llmTier).toBe("standard");
    expect(loadConfig({ TDMCP_LLM_MAX_STEPS: "0" }).llmMaxSteps).toBe(1);
    expect(loadConfig({ TDMCP_LLM_MAX_STEPS: "99" }).llmMaxSteps).toBe(32);
    expect(loadConfig({ TDMCP_LLM_MAX_STEPS: "not-a-number" }).llmMaxSteps).toBe(8);
    expect(loadConfig({ TDMCP_LLM_TEMPERATURE: "-1" }).llmTemperature).toBe(0);
    expect(loadConfig({ TDMCP_LLM_TEMPERATURE: "3" }).llmTemperature).toBe(2);
    expect(loadConfig({ TDMCP_LLM_TEMPERATURE: "not-a-number" }).llmTemperature).toBe(0.4);
  });

  it("builds the TD base URL", () => {
    expect(tdBaseUrl({ tdHost: "127.0.0.1", tdPort: 9980 })).toBe("http://127.0.0.1:9980");
  });

  it("ignores config files unless useFiles is set (deterministic for tests)", () => {
    // Even with a config file in cwd, the bare call must not read it.
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-cfg-"));
    writeFileSync(join(dir, "tdmcp.json"), JSON.stringify({ tdPort: 1234 }));
    try {
      expect(loadConfig({}, { cwd: dir }).tdPort).toBe(9980); // useFiles not set → file ignored
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadConfig — config files & profiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tdmcp-cfg-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeConfig(data: unknown): void {
    writeFileSync(join(dir, "tdmcp.json"), JSON.stringify(data));
  }

  it("reads base values from a config file when useFiles is set", () => {
    writeConfig({ tdHost: "10.0.0.9", vaultPath: "/v" });
    const cfg = loadConfig({}, { useFiles: true, cwd: dir });
    expect(cfg.tdHost).toBe("10.0.0.9");
    expect(cfg.vaultPath).toBe("/v");
  });

  it("can select a config file through TDMCP_CONFIG_FILE", () => {
    const file = join(dir, "venue.json");
    writeFileSync(file, JSON.stringify({ tdHost: "venue-host", tdPort: 9982 }));
    const cfg = loadConfig({ TDMCP_CONFIG_FILE: file }, { useFiles: true, cwd: dir });
    expect(cfg.tdHost).toBe("venue-host");
    expect(cfg.tdPort).toBe(9982);
  });

  it("applies a named profile over the file base", () => {
    writeConfig({ tdPort: 9980, profiles: { club: { tdHost: "192.168.1.5", tdPort: 9981 } } });
    const cfg = loadConfig({}, { useFiles: true, cwd: dir, profile: "club" });
    expect(cfg.tdHost).toBe("192.168.1.5");
    expect(cfg.tdPort).toBe(9981);
  });

  it("lists named profiles without resolving secrets", () => {
    writeConfig({
      tdHost: "base-host",
      profiles: {
        club: { tdHost: "club-host", bridgeToken: "secret" },
        studio: { tdPort: 9999 },
      },
    });

    const listed = listConfigProfiles({}, { useFiles: true, cwd: dir });
    expect(listed.profiles).toEqual([
      { name: "club", keys: ["bridgeToken", "tdHost"] },
      { name: "studio", keys: ["tdPort"] },
    ]);
    expect(JSON.stringify(listed)).not.toContain("secret");
  });

  it("can select a profile through TDMCP_PROFILE when files are enabled", () => {
    writeConfig({ tdHost: "base-host", profiles: { club: { tdHost: "club-host" } } });
    const cfg = loadConfig({ TDMCP_PROFILE: "club" }, { useFiles: true, cwd: dir });
    expect(cfg.tdHost).toBe("club-host");
  });

  it("treats empty local LLM env knobs as unset so profile values survive", () => {
    writeConfig({
      profiles: {
        creative: {
          llmTier: "creative",
          llmMaxSteps: 12,
          llmTemperature: 0.75,
        },
      },
    });

    const cfg = loadConfig(
      {
        TDMCP_LLM_TIER: "",
        TDMCP_LLM_MAX_STEPS: "",
        TDMCP_LLM_TEMPERATURE: "",
      },
      { useFiles: true, cwd: dir, profile: "creative" },
    );

    expect(cfg.llmTier).toBe("creative");
    expect(cfg.llmMaxSteps).toBe(12);
    expect(cfg.llmTemperature).toBe(0.75);
  });

  it("throws a clear error for an unknown profile", () => {
    writeConfig({ profiles: { club: {} } });
    expect(() => loadConfig({}, { useFiles: true, cwd: dir, profile: "nope" })).toThrow(
      /not found/,
    );
  });

  it("precedence: CLI overrides > env > profile > file base > defaults", () => {
    writeConfig({ tdHost: "file-host", tdPort: 1, profiles: { club: { tdHost: "club-host" } } });
    // profile beats base; env beats profile; override beats env.
    const cfg = loadConfig(
      { TDMCP_TD_HOST: "env-host" },
      { useFiles: true, cwd: dir, profile: "club", overrides: { tdHost: "cli-host" } },
    );
    expect(cfg.tdHost).toBe("cli-host");
    // env wins over the profile when no CLI override is given.
    const cfg2 = loadConfig(
      { TDMCP_TD_HOST: "env-host" },
      { useFiles: true, cwd: dir, profile: "club" },
    );
    expect(cfg2.tdHost).toBe("env-host");
    // profile wins over file base when neither env nor CLI is set.
    const cfg3 = loadConfig({}, { useFiles: true, cwd: dir, profile: "club" });
    expect(cfg3.tdHost).toBe("club-host");
    expect(cfg3.tdPort).toBe(1); // from base, profile didn't set it
  });

  it("ignores a malformed config file instead of throwing", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(join(dir, "tdmcp.json"), "{ not valid json");
    try {
      expect(loadConfig({}, { useFiles: true, cwd: dir }).tdPort).toBe(9980);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("describeConfig", () => {
  it("redacts secret keys", () => {
    const cfg = loadConfig({
      TDMCP_BRIDGE_TOKEN: "s3cret",
      TDMCP_LLM_API_KEY: "k3y",
      TDMCP_TELEGRAM_BOT_TOKEN: "telegram-secret",
      TDMCP_TELEGRAM_ALLOWED_CHATS: "111,222",
      TDMCP_TELEGRAM_ALLOWED_USERS: "5,6",
      TDMCP_PROJECT_RAG_GH_TOKEN: "ghp_project_rag_secret",
    });
    const safe = describeConfig(cfg);
    expect(safe.bridgeToken).toBe("***redacted***");
    expect(safe.llmApiKey).toBe("***redacted***");
    expect(safe.telegramBotToken).toBe("***redacted***");
    expect(safe.telegramAllowedChats).toBe("***redacted***");
    expect(safe.telegramAllowedUsers).toBe("***redacted***");
    expect(safe.projectRagGhToken).toBe("***redacted***");
    expect(safe.tdHost).toBe("127.0.0.1");
  });

  it("exposes non-secret local LLM knobs in the safe config description", () => {
    const cfg = loadConfig({
      TDMCP_LLM_TIER: "safe",
      TDMCP_LLM_MAX_STEPS: "5",
      TDMCP_LLM_TEMPERATURE: "0.2",
    });
    const safe = describeConfig(cfg);
    expect(safe.llmTier).toBe("safe");
    expect(safe.llmMaxSteps).toBe(5);
    expect(safe.llmTemperature).toBe(0.2);
  });
});
