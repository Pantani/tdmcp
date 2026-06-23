import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInstallBridge } from "../../src/cli/installBridge.js";

const mocks = vi.hoisted(() => ({
  bridgeModulesDir: vi.fn(),
  cpSync: vi.fn(),
  existsSync: vi.fn(),
  homedir: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    cpSync: mocks.cpSync,
    existsSync: mocks.existsSync,
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: mocks.homedir,
  };
});

vi.mock("../../src/utils/paths.js", () => ({
  bridgeModulesDir: mocks.bridgeModulesDir,
}));

function okInfoResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        td_version: "2023.12000",
        bridge_version: "0.7.0",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function fetchUrl(fetchImpl: ReturnType<typeof vi.fn>, call = 0): string {
  return String(fetchImpl.mock.calls[call]?.[0]);
}

function loggedText(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => String(call[0]))
    .join("\n");
}

function erroredText(): string {
  return vi
    .mocked(console.error)
    .mock.calls.map((call) => String(call[0]))
    .join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bridgeModulesDir.mockReturnValue("/pkg/td/modules");
  mocks.existsSync.mockReturnValue(true);
  mocks.homedir.mockReturnValue("/home/artist");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("install-bridge CLI", () => {
  it("prints help without copying bridge modules", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const result = await runInstallBridge(["--help"]);

    expect(result).toEqual(expect.objectContaining({ ok: true, detail: "install-bridge help" }));
    expect(loggedText()).toContain("tdmcp install-bridge");
    expect(loggedText()).toContain("--dir <path>");
    expect(mocks.cpSync).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("installs bridge modules without probing TouchDesigner by default", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const result = await runInstallBridge(["--dir", "/tmp/tdmcp-bridge"]);

    expect(mocks.cpSync).toHaveBeenCalledWith("/pkg/td/modules", "/tmp/tdmcp-bridge/modules", {
      recursive: true,
    });
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        modulesDir: "/tmp/tdmcp-bridge/modules",
        textportCommand: "from mcp import install; install.run()",
        noPrefsTextportCommand:
          'import sys; sys.path.insert(0, "/tmp/tdmcp-bridge/modules")\nfrom mcp import install; install.run(modules_dir="/tmp/tdmcp-bridge/modules")',
      }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("verifies the default bridge endpoint once with --verify", async () => {
    const fetchImpl = vi.fn(async () => okInfoResponse());
    vi.stubGlobal("fetch", fetchImpl);

    await runInstallBridge(["--dir", "/tmp/tdmcp-bridge", "--verify"]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchUrl(fetchImpl)).toBe("http://127.0.0.1:9980/api/info");
    expect(loggedText()).toContain("Bridge verified");
    expect(loggedText()).toContain("http://127.0.0.1:9980/api/info");
    expect(process.exitCode).toBeUndefined();
  });

  it("uses --port for verification", async () => {
    const fetchImpl = vi.fn(async () => okInfoResponse());
    vi.stubGlobal("fetch", fetchImpl);

    await runInstallBridge(["--verify", "--port", "12001"]);

    expect(fetchUrl(fetchImpl)).toBe("http://127.0.0.1:12001/api/info");
    expect(loggedText()).toContain("install.run(port=12001)");
    expect(loggedText()).toContain("bridge running on port 12001");
    expect(loggedText()).toContain("firewall port 12001");
    expect(mocks.cpSync).toHaveBeenCalledWith(
      "/pkg/td/modules",
      "/home/artist/tdmcp-bridge/modules",
      {
        recursive: true,
      },
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("stages modules and prints Palette package export instructions with --palette", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const result = await runInstallBridge(["--dir", "/tmp/tdmcp-bridge", "--palette"]);

    const paletteCommand = [
      'import sys; sys.path.insert(0, "/tmp/tdmcp-bridge/modules")',
      "from mcp import install",
      'install.export_palette_package(modules_dir="/tmp/tdmcp-bridge/modules", package_name="tdmcp_bridge_package", port=9980)',
    ].join("\n");
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        modulesDir: "/tmp/tdmcp-bridge/modules",
        palettePackageName: "tdmcp_bridge_package",
        palettePackageTextportCommand: paletteCommand,
      }),
    );
    expect(loggedText()).toContain("Palette package export");
    expect(loggedText()).toContain("install.export_palette_package");
    expect(loggedText()).toContain('package_name="tdmcp_bridge_package"');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("threads Palette package options into the generated export command", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const result = await runInstallBridge([
      "--palette",
      "--palette-dir",
      "/Users/artist/Palette",
      "--package-name",
      "tdmcp_bridge_package_dev",
      "--port",
      "12001",
    ]);

    const paletteCommand = [
      'import sys; sys.path.insert(0, "/home/artist/tdmcp-bridge/modules")',
      "from mcp import install",
      'install.export_palette_package(modules_dir="/home/artist/tdmcp-bridge/modules", package_name="tdmcp_bridge_package_dev", palette_dir="/Users/artist/Palette", port=12001)',
    ].join("\n");
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        paletteDir: "/Users/artist/Palette",
        palettePackageName: "tdmcp_bridge_package_dev",
        palettePackageTextportCommand: paletteCommand,
      }),
    );
    expect(loggedText()).toContain('palette_dir="/Users/artist/Palette"');
    expect(loggedText()).toContain("port=12001");
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects --dir without a path", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    await runInstallBridge(["--dir", "--verify"]);

    expect(mocks.cpSync).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(erroredText()).toContain("Missing install-bridge --dir value");
    expect(process.exitCode).toBe(2);
  });

  it("rejects --port without a value", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    await runInstallBridge(["--port"]);

    expect(mocks.cpSync).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(erroredText()).toContain("Missing install-bridge --port value");
    expect(process.exitCode).toBe(2);
  });

  it("rejects --palette-dir without a path", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    await runInstallBridge(["--palette", "--palette-dir", "--package-name", "tdmcp_bridge"]);

    expect(mocks.cpSync).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(erroredText()).toContain("Missing install-bridge --palette-dir value");
    expect(process.exitCode).toBe(2);
  });

  it("rejects --package-name without a value", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    await runInstallBridge(["--palette", "--package-name", "--verify"]);

    expect(mocks.cpSync).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(erroredText()).toContain("Missing install-bridge --package-name value");
    expect(process.exitCode).toBe(2);
  });

  it("rejects unsafe Palette package names before copying modules", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    await runInstallBridge(["--palette", "--package-name", "../tdmcp_bridge"]);

    expect(mocks.cpSync).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(erroredText()).toContain("Invalid install-bridge --package-name value");
    expect(process.exitCode).toBe(2);
  });

  it("polls until the bridge responds when --wait is passed", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(okInfoResponse());
    vi.stubGlobal("fetch", fetchImpl);

    await runInstallBridge(["--wait", "--port", "12002"]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchUrl(fetchImpl, 0)).toBe("http://127.0.0.1:12002/api/info");
    expect(fetchUrl(fetchImpl, 1)).toBe("http://127.0.0.1:12002/api/info");
    expect(loggedText()).toContain("Waiting for TouchDesigner bridge");
    expect(loggedText()).toContain("Bridge verified");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports a clear failure when --verify cannot reach the bridge", async () => {
    const fetchImpl = vi.fn(async () => Response.error());
    vi.stubGlobal("fetch", fetchImpl);

    await runInstallBridge(["--verify"]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(erroredText()).toContain("Could not verify the TouchDesigner bridge");
    expect(erroredText()).toContain("http://127.0.0.1:9980/api/info");
    expect(process.exitCode).toBe(1);
  });
});
