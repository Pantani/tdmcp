import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installClientSnippet, runInstallClient } from "../../src/cli/installClient.js";

let tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  const dirs = tempDirs;
  tempDirs = [];
  return Promise.all(dirs.map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("install-client CLI", () => {
  async function tempConfigPath(name = "client.json"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "tdmcp-install-client-"));
    tempDirs.push(dir);
    return join(dir, name);
  }

  it("prints a supported client configuration", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runInstallClient(["claude"]);

    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledOnce();
    const printed = JSON.parse(String(stdout.mock.calls[0]?.[0]));
    expect(printed).toEqual(installClientSnippet("claude"));
    expect(printed.mcpServers.tdmcp.command).toBe("tdmcp");
  });

  it("prints Codex as a TOML config snippet", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runInstallClient(["codex"]);

    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("[mcp_servers.tdmcp]"));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('command = "tdmcp"'));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("[mcp_servers.tdmcp.env]"));
    expect(installClientSnippet("codex")).toContain("[mcp_servers.tdmcp]");
  });

  it("deep-merges the selected client config without removing existing keys", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const configPath = await tempConfigPath("cursor-mcp.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          appearance: { theme: "dark" },
          mcpServers: {
            existing: { command: "other-tool", args: ["--keep"] },
            tdmcp: {
              command: "old-tdmcp",
              args: ["--old"],
              env: {
                CUSTOM_ENV: "preserve-me",
                TDMCP_TD_HOST: "192.0.2.10",
              },
            },
          },
        },
        null,
        2,
      ),
    );

    await runInstallClient(["cursor", "--write", "--path", configPath]);
    const firstWrite = await readFile(configPath, "utf8");
    await runInstallClient(["cursor", "--write", "--path", configPath]);
    const secondWrite = await readFile(configPath, "utf8");

    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(`Wrote ${configPath}\n`);
    expect(secondWrite).toBe(firstWrite);
    expect(JSON.parse(secondWrite)).toEqual({
      appearance: { theme: "dark" },
      mcpServers: {
        existing: { command: "other-tool", args: ["--keep"] },
        tdmcp: {
          command: "tdmcp",
          args: [],
          env: {
            CUSTOM_ENV: "preserve-me",
            TDMCP_TD_HOST: "127.0.0.1",
            TDMCP_TD_PORT: "9980",
          },
        },
      },
    });
  });

  it("creates a new config file and parent directories when writing", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const configPath = await tempConfigPath(join("nested", "claude.json"));

    await runInstallClient(["claude", "--write", "--path", configPath]);

    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(`Wrote ${configPath}\n`);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      mcpServers: {
        tdmcp: {
          command: "tdmcp",
          args: [],
          env: {
            TDMCP_TD_HOST: "127.0.0.1",
            TDMCP_TD_PORT: "9980",
          },
        },
      },
    });
  });

  it("merges the Codex TOML config without removing unrelated sections", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const configPath = await tempConfigPath(join("codex", "config.toml"));
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      [
        'model = "gpt-5.3-codex"',
        "",
        "[mcp_servers.other]",
        'command = "other"',
        "",
        "[mcp_servers.tdmcp]",
        'command = "old-tdmcp"',
        'args = ["--old"]',
        "",
        "[mcp_servers.tdmcp.env]",
        'TDMCP_TD_HOST = "192.0.2.10"',
        "",
      ].join("\n"),
    );

    await runInstallClient(["codex", "--write", "--path", configPath]);
    const firstWrite = await readFile(configPath, "utf8");
    await runInstallClient(["codex", "--write", "--path", configPath]);
    const secondWrite = await readFile(configPath, "utf8");

    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(`Wrote ${configPath}\n`);
    expect(secondWrite).toBe(firstWrite);
    expect(secondWrite).toContain('model = "gpt-5.3-codex"');
    expect(secondWrite).toContain("[mcp_servers.other]");
    expect(secondWrite).toContain("[mcp_servers.tdmcp]");
    expect(secondWrite).toContain('command = "tdmcp"');
    expect(secondWrite).toContain("[mcp_servers.tdmcp.env]");
    expect(secondWrite).toContain('TDMCP_TD_HOST = "127.0.0.1"');
    expect(secondWrite).not.toContain("old-tdmcp");
    expect(secondWrite).not.toContain("192.0.2.10");
  });

  it("fails clearly without destroying an invalid JSON config", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const configPath = await tempConfigPath(join("claude", "config.json"));
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "{ invalid json");

    await runInstallClient(["claude", "--write", "--path", configPath]);

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`Invalid JSON in ${configPath}:`));
    expect(process.exitCode).toBe(1);
    expect(await readFile(configPath, "utf8")).toBe("{ invalid json");
  });

  it("rejects unknown clients", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runInstallClient(["unknown"]);

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      'Unknown client "unknown". Expected claude, codex, or cursor.\n',
    );
    expect(process.exitCode).toBe(2);
  });
});
