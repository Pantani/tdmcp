import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderStarterConfig, runConfigInit } from "../../src/cli/configInit.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tdmcp-cfg-init-"));
});
afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("renderStarterConfig", () => {
  it("includes every TDMCP_* env var the config schema recognises", () => {
    const body = renderStarterConfig();
    const required = [
      "TDMCP_TD_HOST",
      "TDMCP_TD_PORT",
      "TDMCP_TRANSPORT",
      "TDMCP_LOG_LEVEL",
      "TDMCP_REQUEST_TIMEOUT_MS",
      "TDMCP_HTTP_PORT",
      "TDMCP_EVENTS",
      "TDMCP_RAW_PYTHON",
      "TDMCP_TOOL_PROFILE",
      "TDMCP_BRIDGE_TOKEN",
      "TDMCP_LLM_BASE_URL",
      "TDMCP_LLM_MODEL",
      "TDMCP_LLM_API_KEY",
      "TDMCP_LLM_TIER",
      "TDMCP_LLM_MAX_STEPS",
      "TDMCP_LLM_TEMPERATURE",
      "TDMCP_CHAT_PORT",
      "TDMCP_TELEGRAM_BOT_TOKEN",
      "TDMCP_TELEGRAM_ALLOWED_CHATS",
      "TDMCP_TELEGRAM_ALLOWED_USERS",
      "TDMCP_TELEGRAM_DEFAULT_TIER",
      "TDMCP_TELEGRAM_POLL_TIMEOUT_SEC",
      "TDMCP_TELEGRAM_CONFIRM_TIMEOUT_MS",
      "TDMCP_VAULT_PATH",
      // Config-resolution vars consumed by loadConfig (src/utils/config.ts):
      "TDMCP_CONFIG_FILE",
      "TDMCP_PROFILE",
    ];
    for (const key of required) {
      expect(body).toContain(key);
    }
  });

  it("comments out secrets rather than seeding them with empty values", () => {
    const body = renderStarterConfig();
    expect(body).toMatch(/^# TDMCP_BRIDGE_TOKEN=/m);
    expect(body).toMatch(/^# TDMCP_LLM_API_KEY=/m);
    expect(body).toMatch(/^# TDMCP_TELEGRAM_BOT_TOKEN=/m);
    expect(body).toMatch(/^# TDMCP_TELEGRAM_ALLOWED_CHATS=/m);
    expect(body).toMatch(/^# TDMCP_TELEGRAM_ALLOWED_USERS=/m);
  });
});

describe("runConfigInit", () => {
  it("writes a fresh file at the requested path (code 0)", () => {
    const target = join(tmp, "config.env");
    const result = runConfigInit({ out: target });
    expect(result.code).toBe(0);
    expect(existsSync(target)).toBe(true);
    const written = readFileSync(target, "utf8");
    expect(written).toContain("TDMCP_TD_HOST");
    expect(result.stderr).toContain("Wrote starter tdmcp config");
  });

  it("refuses to overwrite an existing file without --force (code 1)", () => {
    const target = join(tmp, "config.env");
    writeFileSync(target, "PRE-EXISTING\n");
    const result = runConfigInit({ out: target });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing to overwrite");
    expect(readFileSync(target, "utf8")).toBe("PRE-EXISTING\n");
  });

  it("overwrites an existing file with force=true", () => {
    const target = join(tmp, "config.env");
    writeFileSync(target, "PRE-EXISTING\n");
    const result = runConfigInit({ out: target, force: true });
    expect(result.code).toBe(0);
    const written = readFileSync(target, "utf8");
    expect(written).toContain("TDMCP_TD_HOST");
    expect(written).not.toContain("PRE-EXISTING");
  });

  it("creates missing parent directories", () => {
    const target = join(tmp, "nested", "deeper", "config.env");
    const result = runConfigInit({ out: target });
    expect(result.code).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it("expands ~/ in the target path to the user's home directory", () => {
    const result = runConfigInit({ out: "~/some-tdmcp-test/config.env", dryRun: true });
    expect(result.code).toBe(0);
    expect(result.path).toBe(join(homedir(), "some-tdmcp-test", "config.env"));
  });

  it("expands ~\\\\ (Windows separator) in the target path to the user's home directory", () => {
    const result = runConfigInit({ out: "~\\some-tdmcp-test\\config.env", dryRun: true });
    expect(result.code).toBe(0);
    // After expanding the leading ~\\, `path.resolve` normalises separators per
    // platform; on POSIX the rest stays as a single literal segment, so we just
    // assert the home directory was substituted in.
    expect(result.path.startsWith(homedir())).toBe(true);
  });

  it("--dry-run prints the body but does not touch the filesystem", () => {
    const target = join(tmp, "config.env");
    const result = runConfigInit({ out: target, dryRun: true });
    expect(result.code).toBe(0);
    expect(existsSync(target)).toBe(false);
    expect(result.stdout).toContain("TDMCP_TD_HOST");
    expect(result.stderr).toContain("Dry run");
  });
});
