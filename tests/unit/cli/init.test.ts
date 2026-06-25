import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultClientPath,
  detectEnvironment,
  type InitResult,
  parseInitArgs,
  type RunInitDeps,
  resolveClients,
  runInit,
} from "../../../src/cli/init.js";

interface MockFs {
  existing: Set<string>;
  files: Map<string, string>;
}

function makeFs(initial: Iterable<string> = []): MockFs {
  return { existing: new Set(initial), files: new Map() };
}

function makeDeps(
  opts: {
    fs?: MockFs;
    platform?: NodeJS.Platform;
    home?: string;
    bridgeRunning?: boolean;
    configReadJson?: Record<string, unknown> | null;
    configReadText?: string;
    bridgeResult?: Record<string, unknown>;
    bridgeReject?: boolean;
    fetchBridgeReject?: boolean;
    doctorOk?: boolean;
    doctorReject?: boolean;
    configInitCode?: number;
    configInitPath?: string;
    configInitReject?: boolean;
    configInitStderr?: string;
    clientWriteFails?: Set<string>;
    spawnRecord?: string[];
    clipboardRecord?: string[];
    clipboardReject?: boolean;
    token?: string;
  } = {},
): { deps: RunInitDeps; stdout: string[]; stderr: string[] } {
  const fs = opts.fs ?? makeFs();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const spawnRecord = opts.spawnRecord ?? [];
  const clipboardRecord = opts.clipboardRecord ?? [];

  const deps: RunInitDeps = {
    platform: () => opts.platform ?? "darwin",
    homedir: () => opts.home ?? "/home/artist",
    existsSync: (p: string) => fs.existing.has(p),
    readFile: async (p: string) => {
      if (opts.configReadText !== undefined && p.endsWith("tdmcp.json")) {
        return opts.configReadText;
      }
      if (opts.configReadJson !== undefined && p.endsWith("tdmcp.json")) {
        if (opts.configReadJson === null) throw new Error("malformed");
        return JSON.stringify(opts.configReadJson);
      }
      const v = fs.files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: async (p: string, body: string) => {
      fs.files.set(p, body);
      fs.existing.add(p);
    },
    mkdir: async () => undefined,
    randomToken: () => opts.token ?? "tok-deadbeef",
    fetchBridge: async () => {
      if (opts.fetchBridgeReject) throw new Error("bridge offline");
      return Boolean(opts.bridgeRunning);
    },
    spawnTd: (p: string) => spawnRecord.push(p),
    copyToClipboard: async (t: string) => {
      if (opts.clipboardReject) throw new Error("clipboard blocked");
      clipboardRecord.push(t);
      return true;
    },
    runInstallBridge: vi.fn(async () => {
      if (opts.bridgeReject) throw new Error("bridge boom");
      return {
        ok: true,
        detail: "ok",
        textportCommand: "from mcp import install; install.run()",
        noPrefsTextportCommand: "noprefs",
        verified: true,
        ...(opts.bridgeResult ?? {}),
      } as Awaited<ReturnType<typeof import("../../../src/cli/installBridge.js").runInstallBridge>>;
    }) as unknown as RunInitDeps["runInstallBridge"],
    writeInstallClientConfig: vi.fn(async (client: string, path: string) => {
      if (opts.clientWriteFails?.has(client)) throw new Error(`fail ${client}`);
      fs.files.set(path, "patched");
      fs.existing.add(path);
      return {} as Record<string, unknown>;
    }) as unknown as RunInitDeps["writeInstallClientConfig"],
    runConfigInit: vi.fn(() => {
      if (opts.configInitReject) throw new Error("config boom");
      return {
        stdout: "",
        stderr: opts.configInitStderr ?? "",
        code: opts.configInitCode ?? 0,
        path: opts.configInitPath ?? "/home/artist/.tdmcp/config.env",
      };
    }) as unknown as RunInitDeps["runConfigInit"],
    runDoctor: vi.fn(async () => {
      if (opts.doctorReject) throw new Error("doctor boom");
      return {
        stdout: "",
        stderr: "",
        code: opts.doctorOk === false ? 1 : 0,
        report: {
          ok: opts.doctorOk !== false,
          checks: [],
          config: { tdBaseUrl: "", llmBaseUrl: "", llmModel: "", chatPort: 0, vaultPath: null },
        },
      };
    }) as unknown as RunInitDeps["runDoctor"],
    stdout: (s: string) => stdout.push(s),
    stderr: (s: string) => stderr.push(s),
  };

  return { deps, stdout, stderr };
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("parseInitArgs", () => {
  it("accepts the default empty argv", () => {
    const r = parseInitArgs([]);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.yes).toBe(false);
    expect(r.bridgePort).toBe(9980);
    expect(r.profile).toBe("local");
    expect(r.clients).toBe("auto");
  });

  it("parses --yes --dry-run --json and shortcut -y", () => {
    const r = parseInitArgs(["-y", "--dry-run", "--json"]);
    if ("error" in r) throw new Error(r.error);
    expect(r.yes).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.json).toBe(true);
  });

  it("parses --clients csv", () => {
    const r = parseInitArgs(["--clients", "claude,codex"]);
    if ("error" in r) throw new Error(r.error);
    expect(r.clients).toEqual(["claude", "codex"]);
  });

  it("parses --clients none", () => {
    const r = parseInitArgs(["--clients", "none"]);
    if ("error" in r) throw new Error(r.error);
    expect(r.clients).toBe("none");
  });

  it("parses --skip csv into a Set", () => {
    const r = parseInitArgs(["--skip", "bridge,open"]);
    if ("error" in r) throw new Error(r.error);
    expect(r.skip.has("bridge")).toBe(true);
    expect(r.skip.has("open")).toBe(true);
  });

  it("rejects unknown flag with code 2", () => {
    const r = parseInitArgs(["--bogus"]);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.code).toBe(2);
  });

  it("rejects conflicting --no-token + --token", () => {
    const r = parseInitArgs(["--no-token", "--token", "abc"]);
    expect("error" in r).toBe(true);
  });

  it("rejects bad --bridge-port", () => {
    const r = parseInitArgs(["--bridge-port", "0"]);
    expect("error" in r).toBe(true);
  });

  it("rejects bad --clients value", () => {
    const r = parseInitArgs(["--clients", "claude,foo"]);
    expect("error" in r).toBe(true);
  });

  it("rejects bad --skip value", () => {
    const r = parseInitArgs(["--skip", "weird"]);
    expect("error" in r).toBe(true);
  });

  it.each([
    "--bridge-dir",
    "--token",
    "--profile",
    "--td-path",
    "--clients",
    "--skip",
  ])("rejects %s without a value", (flag) => {
    const r = parseInitArgs([flag]);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.code).toBe(2);
  });

  it("rejects unexpected positional arguments", () => {
    const r = parseInitArgs(["project.td"]);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("Unexpected argument");
  });
});

describe("defaultClientPath", () => {
  it("returns the macOS Claude path", () => {
    expect(defaultClientPath("claude", "darwin", "/h")).toBe(
      "/h/Library/Application Support/Claude/claude_desktop_config.json",
    );
  });
  it("returns the Cursor path", () => {
    expect(defaultClientPath("cursor", "linux", "/h")).toBe("/h/.cursor/mcp.json");
  });
  it("returns the Codex path", () => {
    expect(defaultClientPath("codex", "darwin", "/h")).toBe("/h/.codex/config.toml");
  });
  it("returns the Linux Claude path", () => {
    expect(defaultClientPath("claude", "linux", "/h")).toBe(
      "/h/.config/Claude/claude_desktop_config.json",
    );
  });
  it("uses APPDATA for the Windows Claude path when available", () => {
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = "C:\\Users\\artist\\AppData\\Roaming";
    try {
      const p = defaultClientPath("claude", "win32", "/home/artist");
      expect(p).toContain("AppData");
      expect(p).toContain("Claude");
      expect(p).toContain("claude_desktop_config.json");
    } finally {
      if (oldAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = oldAppData;
      }
    }
  });
});

describe("resolveClients", () => {
  const baseDetection = {
    os: "darwin" as NodeJS.Platform,
    td: { found: true, path: "/Applications/TouchDesigner.app" },
    bridge: { running: false, port: 9980 },
    existingConfig: { exists: false, path: "/cwd/tdmcp.json" },
    clients: {
      claude: { exists: true, path: "a" },
      cursor: { exists: true, path: "b" },
      codex: { exists: false, path: "c" },
    },
  } as const;

  it("auto returns detected clients", () => {
    const flags = parseInitArgs([]);
    if ("error" in flags) throw new Error(flags.error);
    expect(resolveClients(flags, baseDetection)).toEqual(["claude", "cursor"]);
  });

  it("none returns empty", () => {
    const flags = parseInitArgs(["--clients", "none"]);
    if ("error" in flags) throw new Error(flags.error);
    expect(resolveClients(flags, baseDetection)).toEqual([]);
  });

  it("explicit csv returns as given", () => {
    const flags = parseInitArgs(["--clients", "codex"]);
    if ("error" in flags) throw new Error(flags.error);
    expect(resolveClients(flags, baseDetection)).toEqual(["codex"]);
  });

  it("auto falls back to claude when nothing detected", () => {
    const flags = parseInitArgs([]);
    if ("error" in flags) throw new Error(flags.error);
    const det = {
      ...baseDetection,
      clients: {
        claude: { exists: false, path: "a" },
        cursor: { exists: false, path: "b" },
        codex: { exists: false, path: "c" },
      },
    };
    expect(resolveClients(flags, det)).toEqual(["claude"]);
  });
});

describe("detectEnvironment", () => {
  function detectionDeps(deps: RunInitDeps) {
    return {
      platform: deps.platform ?? (() => "darwin" as NodeJS.Platform),
      homedir: deps.homedir ?? (() => "/home/artist"),
      existsSync: deps.existsSync ?? (() => false),
      fetchBridge: deps.fetchBridge ?? (async () => false),
      readFile: deps.readFile ?? (async () => ""),
    };
  }

  it("keeps existingConfig when tdmcp.json is malformed and bridge probing fails", async () => {
    const flags = parseInitArgs(["--bridge-port", "1777", "--td-path", "/custom/TouchDesigner"]);
    if ("error" in flags) throw new Error(flags.error);
    const configPath = `${process.cwd()}/tdmcp.json`;
    const fs = makeFs([configPath, "/custom/TouchDesigner", "/home/artist/.codex/config.toml"]);
    const { deps } = makeDeps({ fs, configReadText: "{bad-json", fetchBridgeReject: true });

    const detection = await detectEnvironment(flags, detectionDeps(deps));

    expect(detection.td).toEqual({ found: true, path: "/custom/TouchDesigner" });
    expect(detection.bridge.running).toBe(false);
    expect(detection.existingConfig).toEqual({ exists: true, path: configPath });
    expect(detection.clients.codex.exists).toBe(true);
  });

  it("keeps existingConfig when tdmcp.json parses to a non-object", async () => {
    const flags = parseInitArgs([]);
    if ("error" in flags) throw new Error(flags.error);
    const configPath = `${process.cwd()}/tdmcp.json`;
    const fs = makeFs([configPath]);
    const { deps } = makeDeps({ fs, configReadText: "null" });

    const detection = await detectEnvironment(flags, detectionDeps(deps));

    expect(detection.existingConfig).toEqual({ exists: true, path: configPath });
  });

  it("reports no TouchDesigner candidate on Linux by default", async () => {
    const flags = parseInitArgs([]);
    if ("error" in flags) throw new Error(flags.error);
    const { deps } = makeDeps({ platform: "linux" });

    const detection = await detectEnvironment(flags, detectionDeps(deps));

    expect(detection.td).toEqual({ found: false });
  });
});

describe("runInit", () => {
  it("dry-run + yes: emits would-* steps and touches no files", async () => {
    const fs = makeFs();
    const { deps, stdout } = makeDeps({ fs });
    const result = await runInit(["--yes", "--dry-run", "--json"], deps);

    expect(result.ok).toBe(true);
    expect(fs.files.size).toBe(0);
    expect(deps.runInstallBridge).not.toHaveBeenCalled();
    expect(deps.writeInstallClientConfig).not.toHaveBeenCalled();
    expect(deps.runConfigInit).not.toHaveBeenCalled();
    expect(deps.runDoctor).not.toHaveBeenCalled();

    const wouldSteps = result.steps.filter((s) => s.status === "would").map((s) => s.id);
    expect(wouldSteps).toEqual(expect.arrayContaining(["bridge", "config", "doctor"]));
    expect(stdout.join("\n")).toContain('"ok": true');
  });

  it("--yes runs every step in order with redacted token (bridge running -> --verify)", async () => {
    const fs = makeFs([
      "/Applications/TouchDesigner.app",
      "/home/artist/Library/Application Support/Claude/claude_desktop_config.json",
    ]);
    const { deps } = makeDeps({ fs, platform: "darwin", bridgeRunning: true });
    const result = await runInit(
      ["--yes", "--json", "--bridge-dir", "/home/artist/tdmcp-bridge"],
      deps,
    );

    expect(result.ok).toBe(true);
    expect(deps.runInstallBridge).toHaveBeenCalledWith([
      "--dir",
      "/home/artist/tdmcp-bridge",
      "--port",
      "9980",
      "--token",
      "tok-deadbeef",
      "--verify",
    ]);
    expect(deps.writeInstallClientConfig).toHaveBeenCalledWith(
      "claude",
      "/home/artist/Library/Application Support/Claude/claude_desktop_config.json",
      "tok-deadbeef",
    );
    expect(deps.runConfigInit).toHaveBeenCalled();
    expect(deps.runDoctor).toHaveBeenCalled();
    expect(result.flags.tokenSet).toBe(true);
    expect(result.flags.token).toBe("***");
  });

  it("--yes omits --verify when the bridge is not yet running", async () => {
    const fs = makeFs([
      "/Applications/TouchDesigner.app",
      "/home/artist/Library/Application Support/Claude/claude_desktop_config.json",
    ]);
    const { deps } = makeDeps({ fs, platform: "darwin", bridgeRunning: false });
    const result = await runInit(
      ["--yes", "--json", "--bridge-dir", "/home/artist/tdmcp-bridge"],
      deps,
    );

    expect(result.ok).toBe(true);
    const args = (deps.runInstallBridge as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | string[]
      | undefined;
    expect(args).toBeDefined();
    expect(args).not.toContain("--verify");
    expect(args).toEqual(expect.arrayContaining(["--token", "tok-deadbeef"]));
  });

  it("--show-token reveals the token in --json", async () => {
    const { deps } = makeDeps({ token: "secret-xyz" });
    const r = await runInit(["--yes", "--json", "--show-token"], deps);
    expect(r.flags.token).toBe("secret-xyz");
  });

  it("--no-token skips token generation and passes no token to config init", async () => {
    const { deps } = makeDeps();
    const r = await runInit(["--yes", "--json", "--no-token"], deps);
    const tokenStep = r.steps.find((s) => s.id === "token");
    expect(tokenStep?.status).toBe("skipped");
    expect(tokenStep?.detail).toBe("no-token");
    expect(r.flags.tokenSet).toBe(false);
    const configCall = (deps.runConfigInit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { bridgeToken?: string }
      | undefined;
    expect(configCall?.bridgeToken).toBeUndefined();
  });

  it("rejects unknown flags with exit code 2 and prints help hint", async () => {
    const { deps, stderr } = makeDeps();
    const r = await runInit(["--bogus"], deps);
    expect(process.exitCode).toBe(2);
    expect(r.ok).toBe(false);
    expect(stderr.join("")).toContain("--help");
  });

  it("re-run idempotency: existing token reused, config kept, second run all skipped/ok", async () => {
    const fs = makeFs([
      "/Applications/TouchDesigner.app",
      "/cwd/tdmcp.json",
      "/home/artist/Library/Application Support/Claude/claude_desktop_config.json",
    ]);
    fs.files.set("/cwd/tdmcp.json", JSON.stringify({ bridgeToken: "kept-tok", profile: "local" }));

    // Make readFile read from fs.files for tdmcp.json
    const { deps } = makeDeps({
      fs,
      platform: "darwin",
      configReadJson: { bridgeToken: "kept-tok", profile: "local", tdPort: 9980 },
      configInitCode: 1, // file exists -> kept
      configInitPath: "/home/artist/.tdmcp/config.env",
    });

    // Patch readFile so tdmcp.json detection finds our config:
    const origRead = deps.readFile ?? (async () => "");
    deps.readFile = async (p: string) => {
      if (p.endsWith("tdmcp.json"))
        return JSON.stringify({ bridgeToken: "kept-tok", profile: "local", tdPort: 9980 });
      return origRead(p);
    };
    // The default existsSync is the closure from makeDeps; ensure the cwd tdmcp.json is "existing".
    // Add the path that detectEnvironment will probe — process.cwd()/tdmcp.json:
    fs.existing.add(`${process.cwd()}/tdmcp.json`);

    const r1 = await runInit(["--yes", "--json"], deps);
    expect(r1.ok).toBe(true);
    const tokenStep1 = r1.steps.find((s) => s.id === "token");
    expect(tokenStep1?.status).toBe("skipped");
    expect(tokenStep1?.detail).toContain("reusing");

    const cfgStep = r1.steps.find((s) => s.id === "config");
    expect(cfgStep?.status).toBe("skipped");
  });

  it("install-bridge failure marks step failed with retry hint and continues", async () => {
    const fs = makeFs(["/Applications/TouchDesigner.app"]);
    const { deps } = makeDeps({ fs, bridgeReject: true });
    const r = await runInit(["--yes", "--json"], deps);
    const bridge = r.steps.find((s) => s.id === "bridge");
    expect(bridge?.status).toBe("failed");
    expect(bridge?.retry).toBe("tdmcp install-bridge --verify");
    // subsequent steps still ran
    expect(r.steps.find((s) => s.id === "config")).toBeTruthy();
    expect(r.steps.find((s) => s.id === "doctor")).toBeTruthy();
    expect(r.ok).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("--skip bridge,doctor short-circuits those steps", async () => {
    const { deps } = makeDeps();
    const r = await runInit(["--yes", "--json", "--skip", "bridge,doctor"], deps);
    expect(deps.runInstallBridge).not.toHaveBeenCalled();
    expect(deps.runDoctor).not.toHaveBeenCalled();
    expect(r.steps.find((s) => s.id === "bridge")?.status).toBe("skipped");
    expect(r.steps.find((s) => s.id === "doctor")?.status).toBe("skipped");
  });

  it("--clients none skips the clients step entirely", async () => {
    const { deps } = makeDeps();
    const r = await runInit(["--yes", "--json", "--clients", "none"], deps);
    expect(deps.writeInstallClientConfig).not.toHaveBeenCalled();
    expect(r.steps.find((s) => s.id === "clients")?.status).toBe("skipped");
  });

  it("marks clients failed when every explicit client writer fails", async () => {
    const { deps } = makeDeps({
      clientWriteFails: new Set(["claude", "cursor"]),
    });
    const r = await runInit(["--yes", "--json", "--clients", "claude,cursor"], deps);
    const clients = r.steps.find((s) => s.id === "clients");
    expect(clients?.status).toBe("failed");
    expect(clients?.detail).toContain("claude:fail claude");
    expect(clients?.detail).toContain("cursor:fail cursor");
    expect(clients?.retry).toBe("tdmcp install-client <name> --write --path <file>");
    expect(r.ok).toBe(false);
  });

  it("--open-td with TD missing marks the open step skipped", async () => {
    const { deps } = makeDeps({ fs: makeFs() }); // no TD on disk
    const r = await runInit(["--yes", "--json", "--open-td"], deps);
    const open = r.steps.find((s) => s.id === "open");
    expect(open?.status).toBe("skipped");
    expect(open?.detail).toContain("not found");
  });

  it("--open-td with TD present launches and copies textport command to clipboard", async () => {
    const fs = makeFs(["/Applications/TouchDesigner.app"]);
    const spawnRecord: string[] = [];
    const clipboardRecord: string[] = [];
    const { deps } = makeDeps({ fs, platform: "darwin", spawnRecord, clipboardRecord });
    const r = await runInit(["--yes", "--json", "--open-td"], deps);
    expect(spawnRecord).toEqual(["/Applications/TouchDesigner.app"]);
    expect(clipboardRecord[0]).toContain("install.run");
    expect(r.steps.find((s) => s.id === "open")?.status).toBe("ok");
  });

  it("--open-td in dry-run reports the launch without spawning", async () => {
    const fs = makeFs(["/Applications/TouchDesigner.app"]);
    const spawnRecord: string[] = [];
    const { deps } = makeDeps({ fs, platform: "darwin", spawnRecord });
    const r = await runInit(["--dry-run", "--json", "--open-td"], deps);
    expect(spawnRecord).toEqual([]);
    expect(r.steps.find((s) => s.id === "open")?.status).toBe("would");
  });

  it("--open-td marks open failed when clipboard preparation throws", async () => {
    const fs = makeFs(["/Applications/TouchDesigner.app"]);
    const spawnRecord: string[] = [];
    const { deps } = makeDeps({ fs, platform: "darwin", spawnRecord, clipboardReject: true });
    const r = await runInit(["--yes", "--json", "--open-td"], deps);
    const open = r.steps.find((s) => s.id === "open");
    expect(open?.status).toBe("failed");
    expect(open?.detail).toBe("clipboard blocked");
    expect(spawnRecord).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("client write failure for one client is isolated; others still patched", async () => {
    const fs = makeFs([
      "/home/artist/Library/Application Support/Claude/claude_desktop_config.json",
      "/home/artist/.cursor/mcp.json",
    ]);
    const { deps } = makeDeps({
      fs,
      platform: "darwin",
      clientWriteFails: new Set(["cursor"]),
    });
    const r = await runInit(["--yes", "--json"], deps);
    const clients = r.steps.find((s) => s.id === "clients");
    // claude succeeded, cursor failed → overall "ok" with mixed detail
    expect(clients?.status).toBe("ok");
    expect(clients?.detail).toContain("claude");
    expect(clients?.detail).toContain("cursor");
  });

  it("doctor failure marks doctor step failed without throwing", async () => {
    const { deps } = makeDeps({ doctorOk: false });
    const r: InitResult = await runInit(["--yes", "--json"], deps);
    expect(r.steps.find((s) => s.id === "doctor")?.status).toBe("failed");
    expect(r.ok).toBe(false);
  });

  it("doctor exceptions mark doctor failed without throwing", async () => {
    const { deps } = makeDeps({ doctorReject: true });
    const r = await runInit(["--yes", "--json"], deps);
    const doctor = r.steps.find((s) => s.id === "doctor");
    expect(doctor?.status).toBe("failed");
    expect(doctor?.detail).toBe("doctor boom");
    expect(r.ok).toBe(false);
  });

  it("config init code 2 marks config failed with stderr detail", async () => {
    const { deps, stderr } = makeDeps({
      configInitCode: 2,
      configInitStderr: "bad config\n",
    });
    const r = await runInit(["--yes", "--json"], deps);
    const config = r.steps.find((s) => s.id === "config");
    expect(config?.status).toBe("failed");
    expect(config?.detail).toBe("bad config");
    expect(r.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toContain("Some steps failed");
  });

  it("config init exceptions mark config failed", async () => {
    const { deps } = makeDeps({ configInitReject: true });
    const r = await runInit(["--yes", "--json"], deps);
    const config = r.steps.find((s) => s.id === "config");
    expect(config?.status).toBe("failed");
    expect(config?.detail).toBe("config boom");
    expect(r.ok).toBe(false);
  });

  it("threads --token to bridge install, config init, and client writer", async () => {
    const fs = makeFs([
      "/Applications/TouchDesigner.app",
      "/home/artist/Library/Application Support/Claude/claude_desktop_config.json",
    ]);
    const { deps } = makeDeps({ fs, platform: "darwin" });
    const r = await runInit(["--yes", "--json", "--token", "shared-secret-xyz"], deps);
    expect(r.ok).toBe(true);

    // 1) Bridge installer received --token <value>
    const bridgeCall = (deps.runInstallBridge as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | string[]
      | undefined;
    expect(bridgeCall).toBeDefined();
    expect(bridgeCall).toEqual(expect.arrayContaining(["--token", "shared-secret-xyz"]));

    // 2) Starter config writer received the token in its options
    const configCall = (deps.runConfigInit as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { bridgeToken?: string }
      | undefined;
    expect(configCall?.bridgeToken).toBe("shared-secret-xyz");

    // 3) Client config writer received the token as its third argument
    const clientCall = (deps.writeInstallClientConfig as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown[];
    expect(clientCall?.[2]).toBe("shared-secret-xyz");
  });

  it("--help prints help and exits cleanly", async () => {
    const { deps, stdout } = makeDeps();
    const r = await runInit(["--help"], deps);
    expect(r.ok).toBe(true);
    expect(stdout.join("")).toContain("tdmcp init [options]");
  });

  it("renders a non-json success summary", async () => {
    const { deps, stdout } = makeDeps();
    const r = await runInit(["--yes"], deps);
    expect(r.ok).toBe(true);
    expect(stdout.join("")).toContain("Ready.");
  });

  it("renders a non-json failure summary", async () => {
    const { deps, stdout } = makeDeps({ doctorReject: true });
    const r = await runInit(["--yes"], deps);
    expect(r.ok).toBe(false);
    expect(stdout.join("")).toContain("doctor: doctor boom");
    expect(stdout.join("")).toContain("Some steps failed.");
  });
});
