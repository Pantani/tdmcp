import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEffectiveConfig } from "../../src/cli/runtimeStatus.js";
import {
  createRuntimeStatusDeps,
  runtimeStatusAdapterInternals,
} from "../../src/cli/runtimeStatusAdapters.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const value = mkdtempSync(join(tmpdir(), "tdmcp-runtime-status-"));
  roots.push(value);
  return value;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function config(): RuntimeEffectiveConfig {
  return {
    profile: null,
    source_kind: "defaults",
    transport: "stdio",
    bridge_endpoint: "http://127.0.0.1:9980",
    mcp_endpoint: null,
    http_auth_mode: "none",
    request_timeout_ms: 10_000,
    mcp_http_token_configured: false,
    tool_profile: "full",
    raw_python: "on",
    yolo: false,
  };
}

describe("runtime status production adapters", () => {
  it("reads profile precedence while returning no config path or secret value", () => {
    const root = tempRoot();
    write(
      join(root, "tdmcp.json"),
      JSON.stringify({
        tdPort: 9981,
        bridgeToken: "file-secret",
        profiles: { venue: { tdPort: 9982, toolProfile: "safe" } },
      }),
    );
    const result = runtimeStatusAdapterInternals.effectiveConfig(
      { profile: "venue" },
      {
        cwd: root,
        env: { TDMCP_TD_PORT: "9983", TDMCP_BRIDGE_TOKEN: "env-secret" },
      },
    );
    expect(result.state).toBe("available");
    if (result.state !== "available") return;
    expect(result.config).toMatchObject({
      profile: "venue",
      source_kind: "workspace",
      bridge_endpoint: "http://127.0.0.1:9983",
      bridge_token: "env-secret",
      tool_profile: "safe",
    });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain("file-secret");
  });

  it("distinguishes malformed, missing explicit, and missing profile configs", () => {
    const root = tempRoot();
    const malformed = join(root, "broken.json");
    write(malformed, "{not-json");
    expect(
      runtimeStatusAdapterInternals.effectiveConfig(
        { config_path: malformed },
        { cwd: root, env: {} },
      ),
    ).toMatchObject({ state: "unavailable", reason_code: "config_invalid" });
    expect(
      runtimeStatusAdapterInternals.effectiveConfig(
        { config_path: join(root, "missing.json") },
        { cwd: root, env: {} },
      ),
    ).toMatchObject({ state: "unavailable", reason_code: "config_missing_explicit" });
    write(join(root, "tdmcp.json"), JSON.stringify({ profiles: {} }));
    expect(
      runtimeStatusAdapterInternals.effectiveConfig({ profile: "absent" }, { cwd: root, env: {} }),
    ).toMatchObject({ state: "unavailable", reason_code: "profile_missing" });
  });

  it("observes exact project and user registrations without returning values", () => {
    const root = tempRoot();
    const project = join(root, "project");
    const home = tempRoot();
    const secret = "client-token-canary";
    write(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          tdmcp: {
            command: "tdmcp",
            env: {
              TDMCP_TD_HOST: "127.0.0.1",
              TDMCP_TD_PORT: "9980",
              TDMCP_BRIDGE_TOKEN: secret,
            },
          },
        },
      }),
    );
    write(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
    write(join(project, ".cursor/mcp.json"), JSON.stringify({ mcpServers: {} }));
    write(join(home, ".cursor/mcp.json"), JSON.stringify({ mcpServers: {} }));
    write(
      join(home, ".codex/config.toml"),
      `[mcp_servers.tdmcp]\ncommand = "wrong-command"\nargs = []\n\n[mcp_servers.tdmcp.env]\nTDMCP_TD_HOST = "127.0.0.1"\nTDMCP_TD_PORT = "9981"\nTDMCP_BRIDGE_TOKEN = "${secret}"\n`,
    );
    const observed = runtimeStatusAdapterInternals.readClients(config(), {
      cwd: project,
      homeDir: home,
    });
    expect(observed).toEqual([
      {
        client: "claude",
        scope: "project",
        registration: "registered",
        command_matches: true,
        endpoint_matches: true,
        token_presence: "configured",
      },
      {
        client: "claude",
        scope: "user",
        registration: "not_registered",
        command_matches: null,
        endpoint_matches: null,
        token_presence: "absent",
      },
      {
        client: "cursor",
        scope: "project",
        registration: "not_registered",
        command_matches: null,
        endpoint_matches: null,
        token_presence: "absent",
      },
      {
        client: "cursor",
        scope: "user",
        registration: "not_registered",
        command_matches: null,
        endpoint_matches: null,
        token_presence: "absent",
      },
      {
        client: "codex",
        scope: "user",
        registration: "registered",
        command_matches: false,
        endpoint_matches: false,
        token_presence: "configured",
      },
    ]);
    expect(JSON.stringify(observed)).not.toContain(secret);
    expect(JSON.stringify(observed)).not.toContain(home);
  });

  it("rejects symlinked client config and inspects four skill targets without writing", async () => {
    const root = tempRoot();
    const home = join(root, "home");
    const outside = join(root, "outside.json");
    write(outside, JSON.stringify({ mcpServers: { tdmcp: { command: "tdmcp" } } }));
    mkdirSync(join(home, ".cursor"), { recursive: true });
    symlinkSync(outside, join(home, ".cursor/mcp.json"));
    const deps = createRuntimeStatusDeps({
      cwd: join(root, "project"),
      homeDir: home,
      platform: "linux",
      env: { CODEX_HOME: join(home, ".codex"), XDG_CONFIG_HOME: join(home, ".config") },
    });
    const clients = await deps.readClients?.(config());
    expect(
      clients?.find((item) => item.client === "cursor" && item.scope === "user")?.registration,
    ).toBe("invalid");
    const skills = await deps.readSkills?.();
    expect(skills).toHaveLength(4);
    expect(skills?.every((item) => item.action === "status" && item.dry_run)).toBe(true);
  });

  it("isolates an invalid skill manifest instead of hiding every installation", async () => {
    const root = tempRoot();
    const project = join(root, "project");
    write(join(project, ".agents/skills/.tdmcp-skills.json"), "{invalid-json");
    const deps = createRuntimeStatusDeps({
      cwd: project,
      homeDir: join(root, "home"),
      platform: "linux",
      env: { CODEX_HOME: join(root, "home/.codex") },
    });
    const skills = await deps.readSkills?.();
    expect(skills).toHaveLength(4);
    expect(skills?.find((item) => item.host === "codex" && item.scope === "project")?.status).toBe(
      "failed",
    );
    expect(skills?.filter((item) => item.status === "failed")).toHaveLength(1);
  });
});
