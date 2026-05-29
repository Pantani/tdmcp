import { afterEach, describe, expect, it, vi } from "vitest";
import { installClientSnippet, runInstallClient } from "../../src/cli/installClient.js";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("install-client CLI", () => {
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

  it("uses the Codex snake_case MCP server shape", () => {
    expect(installClientSnippet("codex")).toEqual({
      client: "codex",
      mcp_servers: {
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
    expect(installClientSnippet("codex")).not.toHaveProperty("mcpServers");
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
