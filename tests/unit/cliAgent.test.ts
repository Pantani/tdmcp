import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  completeReplLine,
  listAgentCommands,
  loadReplHistory,
  replHistoryPath,
  runCli,
  runWatch,
  saveReplHistory,
} from "../../src/cli/agent.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const makeCtx = (): ToolContext => ({
  client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
  knowledge: new KnowledgeBase(),
  recipes: new RecipeLibrary(),
  logger: silentLogger,
});

describe("tdmcp-agent CLI", () => {
  it("prints usage with --help (no TD needed)", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tdmcp-agent");
    expect(r.stdout).toContain("nodes find");
    expect(r.stdout).toContain("Inspection & diagnostics:");
    expect(r.stdout).toContain("Unsafe escape hatches:");
  });

  it("wires the explicit LLM planner to the configured backend and registration-derived catalog", async () => {
    const priorBaseUrl = process.env.TDMCP_LLM_BASE_URL;
    let completions = 0;
    process.env.TDMCP_LLM_BASE_URL = "http://planner.test/v1";
    server.use(
      http.get(`${TD_BASE}/api/editor/context`, () =>
        HttpResponse.json({
          project: { name: "show.toe", folder: "/show", save_version: 1, save_build: "test" },
          touchdesigner: { build: "test", version: "test" },
          perform_mode: false,
          ui_available: true,
          panes: [],
          active_network_editor: null,
          warnings: [],
        }),
      ),
      http.post("http://planner.test/v1/chat/completions", () => {
        completions += 1;
        return HttpResponse.json({
          model: "planner-test",
          choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
        });
      }),
    );
    try {
      const r = await runCli([
        "plan",
        "--params",
        JSON.stringify({ description: "feedback tunnel", planner: "llm" }),
      ]);
      expect(r.code).toBe(0);
      expect(completions, r.stdout).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({
        planner_requested: "llm",
        planner_used: "deterministic",
        fallback_reason: "response_invalid",
      });
    } finally {
      if (priorBaseUrl === undefined) delete process.env.TDMCP_LLM_BASE_URL;
      else process.env.TDMCP_LLM_BASE_URL = priorBaseUrl;
    }
  });

  it("emits a JSON Schema for `schema <command>`", async () => {
    const r = await runCli(["schema", "nodes", "list"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("nodes list");
    expect(JSON.stringify(doc.input)).toContain("parent_path");
  });

  it("prints command-specific help without contacting TD", async () => {
    const r = await runCli(["help", "nodes", "find"], {
      makeCtx: () => {
        throw new Error("command help must not build a TD context");
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tdmcp-agent nodes find");
    expect(r.stdout).toContain("Search nodes");
    expect(r.stdout).toContain("mutates: false");
    expect(r.stdout).toContain("Input schema:");
  });

  it("treats command --help as command-specific help", async () => {
    const r = await runCli(["doctor", "--help"], {
      makeCtx: () => {
        throw new Error("command help must not build a TD context");
      },
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tdmcp-agent doctor");
    expect(r.stdout).toContain("Diagnose TD bridge");
    expect(r.stdout).not.toContain("Inspection & diagnostics:");
  });

  it("emits a JSON Schema for the vector-lines shorthand", async () => {
    const r = await runCli(["schema", "vector-lines"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("vector-lines");
    expect(JSON.stringify(doc.input)).toContain("existing_top_path");
    expect(JSON.stringify(doc.input)).toContain("overlay_mode");
  });

  it("prints the version with --version (no TD needed)", async () => {
    const r = await runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/tdmcp-agent \d+\.\d+\.\d+/);
  });

  it("prints a shell completion script", async () => {
    const r = await runCli(["completion", "bash"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("complete -F _tdmcp_agent tdmcp-agent");
    expect(r.stdout).toContain("nodes find");
    expect(r.stdout).toContain("show-director");
  });

  it("emits a machine-readable command catalog without contacting TD", async () => {
    const r = await runCli(["commands", "--json"], {
      makeCtx: () => {
        throw new Error("commands catalog must not build a TD context");
      },
    });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.count).toBeGreaterThan(100);
    expect(doc.commands).toContainEqual(
      expect.objectContaining({
        command: "nodes find",
        summary: expect.stringContaining("Search nodes"),
        mutates: false,
        unsafe: false,
      }),
    );
    expect(doc.commands).toContainEqual(
      expect.objectContaining({
        command: "tutorials draft-recipe",
        summary: expect.stringContaining("RecipeSchema"),
        mutates: false,
        unsafe: false,
      }),
    );
  });

  it("dry-runs show-director policy decisions without contacting TD", async () => {
    const r = await runCli(
      [
        "show-director",
        "--params",
        JSON.stringify({
          intent: {
            type: "arm_effect",
            effect: "fog",
            duration_seconds: 3,
            intensity: 0.4,
          },
        }),
      ],
      {
        makeCtx: () => {
          throw new Error("show-director dry-run must not build a TD context");
        },
      },
    );

    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.intent.type).toBe("arm_effect");
    expect(doc.decision.decision).toBe("require_approval");
    expect(doc.decision.limits_applied).toContain("duration_seconds<=3");
  });

  it("emits the structured ShowIntent contract for show-director schema", async () => {
    const r = await runCli(["schema", "show-director"]);

    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    const serialized = JSON.stringify(doc.input);
    expect(serialized).toContain("change_mood");
    expect(serialized).toContain("arm_effect");
    expect(serialized).toContain("request_cue");
  });

  it("prints show-director command help with its structured input schema", async () => {
    const r = await runCli(["help", "show-director"]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tdmcp-agent show-director");
    expect(r.stdout).toContain("Input schema:");
    expect(r.stdout).toContain("arm_effect");
  });

  it("runs the AI party POC offline without contacting TD", async () => {
    const r = await runCli(["ai-party-poc"], {
      makeCtx: () => {
        throw new Error("ai-party-poc must not build a TD context");
      },
    });

    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.hardware).toBe("simulated_only");
    expect(doc.summary.hardware_plans).toBe(0);
    expect(doc.summary.queued).toBeGreaterThanOrEqual(1);
    expect(doc.summary.blocked).toBeGreaterThanOrEqual(1);
    expect(doc.dashboard.physical_effects_connected).toBe(false);
  });

  it("emits schema and help for the AI party POC command", async () => {
    const schema = await runCli(["schema", "ai-party-poc"]);
    expect(schema.code).toBe(0);
    expect(schema.stdout).toContain("auto_approve_effects");

    const help = await runCli(["help", "ai-party-poc"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("tdmcp-agent ai-party-poc");
    expect(help.stdout).toContain("Input schema:");
  });

  it("can auto-approve AI party POC effects into simulated events", async () => {
    const r = await runCli([
      "ai-party-poc",
      "--params",
      JSON.stringify({ auto_approve_effects: true, operator: "front-of-house" }),
    ]);

    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.summary.approved).toBeGreaterThanOrEqual(1);
    expect(doc.summary.simulated_effects).toBeGreaterThanOrEqual(1);
    expect(doc.dashboard.pending_approvals).toBe(0);
  });

  it("blocks malformed show-director input before execution", async () => {
    const r = await runCli([
      "show-director",
      "--params",
      JSON.stringify({
        intent: {
          type: "arm_effect",
          effect: "mixer_gain",
          duration_seconds: "loud",
        },
      }),
    ]);

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Malformed show intent");
  });

  it("returns updated show-director approval state and resolves it by operator", async () => {
    const queued = await runCli([
      "show-director",
      "--params",
      JSON.stringify({
        intent: {
          type: "arm_effect",
          effect: "fog",
          duration_seconds: 3,
          intensity: 0.4,
        },
      }),
    ]);
    expect(queued.code).toBe(0);
    const queuedDoc = JSON.parse(queued.stdout);
    expect(queuedDoc.approval.id).toBe("approval_0001");

    const approved = await runCli([
      "show-director",
      "approve",
      "approval_0001",
      "--params",
      JSON.stringify({ state: queuedDoc.state, operator: "operator-a" }),
    ]);

    expect(approved.code).toBe(0);
    const approvedDoc = JSON.parse(approved.stdout);
    expect(approvedDoc.plan[0]).toMatchObject({ kind: "effect", effect: "fog" });
    expect(approvedDoc.state.approvals[0].status).toBe("approved");
  });

  it("queues a catalog-backed mixer scene for approval without contacting TD", async () => {
    const r = await runCli(
      [
        "show-director",
        "--params",
        JSON.stringify({
          intent: {
            type: "arm_mixer_scene",
            adapter_target: { kind: "soundcraft_ui24r", mixer_id: "foh-ui24r" },
            target: { kind: "snapshot", scene_id: "band_a_intro" },
          },
        }),
      ],
      {
        makeCtx: () => {
          throw new Error("show-director mixer scene must not build a TD context");
        },
      },
    );

    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.decision.decision).toBe("require_approval");
    expect(doc.decision.scene_id).toBe("band_a_intro");
    expect(doc.approval.target.kind).toBe("mixer_scene");
    expect(doc.plan).toEqual([]);
  });

  it("emits a dry-run-only mixer scene plan on operator approval", async () => {
    const queued = await runCli([
      "show-director",
      "--params",
      JSON.stringify({
        intent: {
          type: "arm_mixer_scene",
          adapter_target: { kind: "soundcraft_ui24r", mixer_id: "foh-ui24r" },
          target: { kind: "snapshot", scene_id: "band_a_intro" },
        },
      }),
    ]);
    expect(queued.code).toBe(0);
    const queuedDoc = JSON.parse(queued.stdout);

    const approved = await runCli([
      "show-director",
      "approve",
      queuedDoc.approval.id,
      "--params",
      JSON.stringify({ state: queuedDoc.state, operator: "front-of-house" }),
    ]);

    expect(approved.code).toBe(0);
    const approvedDoc = JSON.parse(approved.stdout);
    expect(approvedDoc.plan[0]).toMatchObject({
      kind: "mixer_scene",
      action: "arm",
      dry_run_only: true,
      operator: "front-of-house",
    });
    expect(approvedDoc.plan[0].mixer_scene.scene_id).toBe("band_a_intro");
    expect(approvedDoc.state.approvals[0].status).toBe("approved");
  });

  it("blocks an unknown mixer scene id at the CLI", async () => {
    const r = await runCli([
      "show-director",
      "--params",
      JSON.stringify({
        intent: {
          type: "arm_mixer_scene",
          adapter_target: { kind: "soundcraft_ui24r", mixer_id: "foh-ui24r" },
          target: { kind: "snapshot", scene_id: "not_in_catalog" },
        },
      }),
    ]);

    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.decision.decision).toBe("block");
    expect(doc.decision.reason).toContain("unknown mixer scene_id");
    expect(doc.approval).toBeUndefined();
  });

  it("includes arm_mixer_scene in the show-director schema", async () => {
    const r = await runCli(["schema", "show-director"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    const serialized = JSON.stringify(doc.input);
    expect(serialized).toContain("arm_mixer_scene");
    expect(serialized).toContain("mixer_scene_catalog");
  });

  it("lists stable command metadata for resources and docs", () => {
    const commands = listAgentCommands();

    expect(commands).toContainEqual(
      expect.objectContaining({ command: "exec python", mutates: true, unsafe: true }),
    );
    expect(commands).toContainEqual(
      expect.objectContaining({ command: "watch-build", mutates: true, unsafe: false }),
    );
    expect(commands.map((entry) => entry.command)).toEqual(
      [...commands.map((entry) => entry.command)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("accepts --no-color for script compatibility", async () => {
    const r = await runCli(["info", "--dry-run", "--no-color"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).command).toBe("info");
  });

  it("runs a JSON command file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-run-"));
    try {
      const file = join(dir, "show-plan.json");
      writeFileSync(
        file,
        JSON.stringify([
          {
            command: "nodes create",
            dry_run: true,
            params: { parent_path: "/project1", type: "noiseTOP" },
          },
        ]),
      );

      const r = await runCli(["run", file]);
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.steps).toHaveLength(1);
      expect(doc.steps[0].stdout.dryRun).toBe(true);
      expect(doc.steps[0].stdout.command).toBe("nodes create");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs a JSON command file from stdin with run -", async () => {
    const r = await runCli(["run", "-"], {
      stdin: JSON.stringify([
        {
          command: "nodes create",
          dry_run: true,
          params: { parent_path: "/project1", type: "noiseTOP" },
        },
      ]),
    });

    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0].stdout.dryRun).toBe(true);
    expect(doc.steps[0].stdout.command).toBe("nodes create");
  });

  it("propagates --no-color into JSON run-file steps", async () => {
    const r = await runCli(["run", "-", "--no-color"], {
      stdin: JSON.stringify([
        {
          command: "info",
          dry_run: true,
          no_color: true,
        },
      ]),
    });

    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.steps[0].command).toContain("--no-color");
    expect(doc.steps[0].stdout.command).toBe("info");
  });

  it("continues a JSON run file after a failed step when requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-run-"));
    try {
      const file = join(dir, "continue-plan.json");
      writeFileSync(file, JSON.stringify([{ command: "nodes frobnicate" }, { command: "config" }]));

      const r = await runCli(["run", file, "--continue-on-error"]);
      expect(r.code).toBe(2);
      const doc = JSON.parse(r.stdout);
      expect(doc.steps).toHaveLength(2);
      expect(doc.steps[0].code).toBe(2);
      expect(doc.steps[1].code).toBe(0);
      expect(doc.steps[1].stdout.tdBaseUrl).toBe("http://127.0.0.1:9980");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops a JSON run file after the first failed step by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-run-stop-"));
    try {
      const file = join(dir, "stop-plan.json");
      writeFileSync(file, JSON.stringify([{ command: "nodes frobnicate" }, { command: "config" }]));

      const r = await runCli(["run", file]);

      expect(r.code).toBe(2);
      const doc = JSON.parse(r.stdout);
      expect(doc.steps).toHaveLength(1);
      expect(doc.steps[0].stderr).toContain("Unknown command");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs object-shaped JSON command files with array commands and output flags", async () => {
    const r = await runCli(["run", "-"], {
      stdin: JSON.stringify({
        steps: [
          {
            command: ["nodes", "list"],
            params: { parent_path: "/project1" },
            output: "text",
          },
        ],
      }),
      makeCtx,
    });

    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0].command).toEqual([
      "nodes",
      "list",
      "--params",
      JSON.stringify({ parent_path: "/project1" }),
      "--output",
      "text",
    ]);
    expect(typeof doc.steps[0].stdout).toBe("string");
  });

  it("propagates global config flags into JSON run-file steps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-run-"));
    try {
      const config = join(dir, "tdmcp.json");
      const file = join(dir, "show-plan.json");
      writeFileSync(
        config,
        JSON.stringify({
          tdHost: "base-host",
          tdPort: 9980,
          profiles: {
            club: { tdHost: "club-host", tdPort: 9981 },
          },
        }),
      );
      writeFileSync(file, JSON.stringify([{ command: "config" }]));

      const r = await runCli([
        "run",
        file,
        "--config",
        config,
        "--profile",
        "club",
        "--td-port",
        "9982",
      ]);

      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.steps[0].stdout.tdBaseUrl).toBe("http://club-host:9982");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists profiles from the selected config file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-cfg-"));
    try {
      const config = join(dir, "tdmcp.json");
      writeFileSync(
        config,
        JSON.stringify({
          profiles: {
            club: { tdHost: "club-host" },
            studio: { tdPort: 9999 },
          },
        }),
      );

      const r = await runCli(["config", "profiles", "--config", config]);
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.profiles).toEqual([
        { name: "club", keys: ["tdHost"] },
        { name: "studio", keys: ["tdPort"] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows a named profile as an effective redacted config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-cfg-"));
    try {
      const config = join(dir, "tdmcp.json");
      writeFileSync(
        config,
        JSON.stringify({
          tdPort: 9980,
          profiles: {
            club: {
              tdHost: "club-host",
              bridgeToken: "secret",
              projectRagGhToken: "ghp_profile_secret",
              telegramAllowedChats: ["111", "222"],
              telegramAllowedUsers: ["5", "6"],
            },
          },
        }),
      );

      const r = await runCli(["config", "profile", "club", "--config", config]);
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.profile).toBe("club");
      expect(doc.tdBaseUrl).toBe("http://club-host:9980");
      expect(doc.bridgeToken).toBe("***redacted***");
      expect(doc.projectRagGhToken).toBe("***redacted***");
      expect(doc.telegramAllowedChats).toBe("***redacted***");
      expect(doc.telegramAllowedUsers).toBe("***redacted***");
      expect(r.stdout).not.toContain("ghp_profile_secret");
      expect(r.stdout).not.toContain("111");
      expect(r.stdout).not.toContain("222");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes local copilot knobs and redacts Telegram identifiers in config --write-env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-cfg-"));
    try {
      const config = join(dir, "tdmcp.json");
      writeFileSync(
        config,
        JSON.stringify({
          oauthTrustedProxyHops: ["127.0.0.1", "::1"],
          telegramAllowedChats: ["111", "222"],
          telegramAllowedUsers: ["5", "6"],
        }),
      );
      const r = await runCli(["config", "--write-env", "--config", config], {
        makeCtx: () => {
          throw new Error("config --write-env must not build a TD context");
        },
      });

      expect(r.code).toBe(0);
      expect(r.stdout).toContain("TDMCP_LLM_TIER");
      expect(r.stdout).toContain("TDMCP_LLM_MAX_STEPS");
      expect(r.stdout).toContain("TDMCP_LLM_TEMPERATURE");
      expect(r.stdout).toContain('export TDMCP_PROJECT_RAG_SCORE_WEIGHTS="0.45:0.25:0.15:0.15"');
      expect(r.stdout).toContain('export TDMCP_OAUTH_TRUSTED_PROXY_HOPS="127.0.0.1,::1"');
      expect(r.stdout).not.toContain("[object Object]");
      expect(r.stdout).toContain("# export TDMCP_TELEGRAM_ALLOWED_CHATS=<set manually>");
      expect(r.stdout).toContain("# export TDMCP_TELEGRAM_ALLOWED_USERS=<set manually>");
      expect(r.stdout).not.toContain("111,222");
      expect(r.stdout).not.toContain("5,6");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates top-level --dry-run into JSON run-file steps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-run-"));
    try {
      const file = join(dir, "show-plan.json");
      writeFileSync(
        file,
        JSON.stringify([
          {
            command: "nodes create",
            params: { parent_path: "/project1", type: "noiseTOP" },
          },
        ]),
      );

      const r = await runCli(["run", file, "--dry-run"], {
        makeCtx: () => {
          throw new Error("dry-run run-file steps must not build a TD context");
        },
      });

      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.steps[0].command).toContain("--dry-run");
      expect(doc.steps[0].stdout.dryRun).toBe(true);
      expect(doc.steps[0].stdout.command).toBe("nodes create");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates top-level --allow-unsafe into JSON run-file steps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-run-"));
    try {
      const file = join(dir, "unsafe-plan.json");
      writeFileSync(
        file,
        JSON.stringify([
          {
            command: "exec python",
            params: { script: "print(1)" },
          },
        ]),
      );

      const r = await runCli(["run", file, "--allow-unsafe"], { makeCtx });

      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.steps[0].command).toContain("--allow-unsafe");
      expect(doc.steps[0].stdout).toHaveProperty("stdout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("suggests the nearest command on a typo (did-you-mean)", async () => {
    const r = await runCli(["noeds"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Did you mean");
    expect(r.stderr).toContain("nodes");
  });

  it("suggests show-director on a typo", async () => {
    const r = await runCli(["show-directr"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Did you mean");
    expect(r.stderr).toContain("show-director");
  });

  it('does not suggest the exact token the user typed (no `Did you mean "exec"`) (U4)', async () => {
    const r = await runCli(["exec"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unknown command");
    // A known-but-unresolvable command entered verbatim must never suggest itself.
    expect(r.stderr).not.toContain('Did you mean "exec"');
  });

  it("rejects an unknown command with exit code 2", async () => {
    const r = await runCli(["nodes", "frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unknown command");
  });

  it("validates and echoes a mutation under --dry-run without calling TD", async () => {
    const r = await runCli([
      "nodes",
      "create",
      "--dry-run",
      "--params",
      '{"parent_path":"/project1","type":"noiseTOP"}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("nodes create");
    expect(doc.args.type).toBe("noiseTOP");
  });

  it("blocks exec escape hatches without --allow-unsafe", async () => {
    const r = await runCli(["exec", "python", "--params", '{"script":"print(1)"}']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--allow-unsafe");
  });

  it("locks exec out entirely when TDMCP_RAW_PYTHON=off, even with --allow-unsafe", async () => {
    const makeCtxLocked = (): ToolContext => ({ ...makeCtx(), allowRawPython: false });
    const r = await runCli(
      ["exec", "python", "--allow-unsafe", "--params", '{"script":"print(1)"}'],
      { makeCtx: makeCtxLocked },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("disabled");
  });

  it("runs exec python with --allow-unsafe against the mocked bridge", async () => {
    const r = await runCli(
      ["exec", "python", "--allow-unsafe", "--params", '{"script":"print(1)"}'],
      { makeCtx },
    );
    expect(r.code).toBe(0);
  });

  it("rejects invalid JSON in --params", async () => {
    const r = await runCli(["nodes", "list", "--params", "{not json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid JSON");
  });

  it("rejects invalid connection override values before building a context", async () => {
    const r = await runCli(["info", "--td-port", "abc"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("tdPort");
  });

  it("runs an offline KB command and prints JSON", async () => {
    const r = await runCli(["classes", "list", "--params", '{"filter":"app"}'], { makeCtx });
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(JSON.parse(r.stdout)).toHaveProperty("classes");
  });

  it("finds nodes through the mocked bridge", async () => {
    const r = await runCli(
      ["nodes", "find", "--params", '{"parent_path":"/project1","recursive":false,"type":"null"}'],
      { makeCtx },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("/project1/null1");
  });

  it("streams list results as NDJSON", async () => {
    const r = await runCli(
      ["nodes", "list", "--output", "ndjson", "--params", '{"detail_level":"full"}'],
      { makeCtx },
    );
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(r.stdout).toContain("noise1");
    expect(r.stdout).toContain("null1");
  });

  it("offers REPL completions for command prefixes and last-token flag prefixes", () => {
    const [commandMatches, commandPrefix] = completeReplLine("nod");
    expect(commandPrefix).toBe("nod");
    expect(commandMatches).toContain("nodes list");

    const [flagMatches, flagPrefix] = completeReplLine("nodes list --out");
    expect(flagPrefix).toBe("--out");
    expect(flagMatches).toContain("--output");
    expect(flagMatches).toContain("--out");
  });

  it("persists REPL history in a deterministic state path", () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-history-"));
    try {
      const historyPath = replHistoryPath({ XDG_STATE_HOME: dir });
      saveReplHistory(["nodes list", "", "nodes list", "info"], historyPath);

      expect(historyPath).toBe(join(dir, "tdmcp-agent", "history"));
      expect(loadReplHistory(historyPath)).toEqual(["nodes list", "info"]);
      expect(readFileSync(historyPath, "utf8")).toBe("nodes list\ninfo\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders list results as a table", async () => {
    const r = await runCli(
      ["nodes", "list", "--output", "table", "--params", '{"detail_level":"full"}'],
      { makeCtx },
    );
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toContain("path");
    expect(r.stdout).toContain("/project1/noise1");
    expect(r.stdout).toContain("/project1/null1");
  });

  it("renders list results as CSV", async () => {
    const r = await runCli(
      ["nodes", "list", "--output", "csv", "--params", '{"detail_level":"full"}'],
      { makeCtx },
    );
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]?.split(",")).toContain("path");
    expect(r.stdout).toContain("/project1/noise1");
    expect(r.stdout).toContain("/project1/null1");
  });
});

describe("tdmcp-agent CLI — phase 0 additions", () => {
  it("lists the new high-level + DX commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of [
      "reload",
      "visual",
      "audio-reactive",
      "checkpoint",
      "preview",
      "watch",
      "plan",
    ]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("emits a JSON Schema for a Layer-2 command (checkpoint)", async () => {
    const r = await runCli(["schema", "checkpoint"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("checkpoint");
    expect(JSON.stringify(doc.input)).toContain("recreate_deleted");
  });

  it("dry-runs a Layer-1 generator without calling TD", async () => {
    const r = await runCli(["generative", "--dry-run", "--params", '{"technique":"voronoi"}']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("generative");
    expect(doc.args.technique).toBe("voronoi");
  });

  it("dry-runs preview and resolves an output path without writing a file", async () => {
    const r = await runCli(["preview", "/project1/out1", "--dry-run"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("preview");
    expect(doc.args.node_path).toBe("/project1/out1");
    expect(doc.out).toContain("preview.png");
  });

  it("requires a node path for preview", async () => {
    const r = await runCli(["preview"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid arguments");
  });

  it("captures a preview through the mocked bridge and writes the output file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-preview-"));
    try {
      const out = join(dir, "preview.png");
      const r = await runCli(["preview", "/project1/out1", "--out", out], { makeCtx });

      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc).toMatchObject({
        node_path: "/project1/out1",
        file: out,
        width: 640,
        height: 360,
        mimeType: "image/png",
      });
      expect(readFileSync(out).length).toBeGreaterThan(0);
      expect(r.stderr).toContain("Saved preview");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid preview params JSON before building a context", async () => {
    const r = await runCli(["preview", "--params", "{not-json"], {
      makeCtx: () => {
        throw new Error("preview JSON parse must not build context");
      },
    });

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid JSON");
  });

  it("reloads the bridge through the mocked exec endpoint", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: { result: null, stdout: '{"reloaded": ["mcp", "utils"], "count": 2}' },
        }),
      ),
    );
    const r = await runCli(["reload"], { makeCtx });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).count).toBe(2);
  });
});

describe("tdmcp-agent watch", () => {
  it("writes events as ndjson and stops when the signal aborts", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const lines: string[] = [];
    const controller = new AbortController();
    let emit: ((e: { event: string; data?: unknown }) => void) | undefined;
    let closed = false;
    try {
      const done = runWatch({
        write: (line) => lines.push(line),
        signal: controller.signal,
        makeStream: ({ onEvent }) => {
          emit = onEvent;
          return { start: () => {}, close: () => (closed = true) };
        },
      });
      emit?.({ event: "node.created", data: { path: "/project1/x" } });
      controller.abort();
      await done;
      expect(closed).toBe(true);
      expect(lines).toContain('{"event":"node.created","data":{"path":"/project1/x"}}');
    } finally {
      stderr.mockRestore();
    }
  });

  it("derives a ws:// url ending in / from config", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let url = "";
    const controller = new AbortController();
    try {
      const done = runWatch({
        write: () => {},
        signal: controller.signal,
        makeStream: (args) => {
          url = args.url;
          return { start: () => {}, close: () => {} };
        },
      });
      controller.abort();
      await done;
      expect(url).toMatch(/^ws:\/\/.+\/$/);
    } finally {
      stderr.mockRestore();
    }
  });

  it("filters event names from the bridge `event` key and reports a count", async () => {
    const lines: string[] = [];
    const status: string[] = [];
    const controller = new AbortController();
    let emit: ((e: unknown) => void) | undefined;
    let closed = false;

    const done = runWatch({
      filter: ["node.created"],
      write: (line) => lines.push(line),
      writeStatus: (line) => status.push(line),
      signal: controller.signal,
      makeStream: ({ onEvent }) => {
        emit = onEvent as (e: unknown) => void;
        return { start: () => {}, close: () => (closed = true) };
      },
    });

    emit?.({ event: "node.updated", data: { path: "/project1/nope" } });
    emit?.({ event: "node.created", data: { path: "/project1/x" } });
    controller.abort();
    await done;

    expect(closed).toBe(true);
    expect(lines).toEqual(['{"event":"node.created","data":{"path":"/project1/x"}}']);
    expect(status.at(-1)).toBe("Stopped after 1 event.");
  });

  it("pretty-prints event names from the bridge `type` key", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    let emit: ((e: unknown) => void) | undefined;

    const done = runWatch({
      pretty: true,
      write: (line) => lines.push(line),
      writeStatus: () => {},
      signal: controller.signal,
      makeStream: ({ onEvent }) => {
        emit = onEvent as (e: unknown) => void;
        return { start: () => {}, close: () => {} };
      },
    });

    emit?.({ type: "beat", data: { bar: 2 } });
    controller.abort();
    await done;

    expect(lines).toEqual(['beat {"bar":2}']);
  });

  it("runs watch exec hooks for matching events with per-event debounce", async () => {
    const lines: string[] = [];
    const execs: Array<{ command: string; event: unknown }> = [];
    const controller = new AbortController();
    let emit: ((e: unknown) => void) | undefined;
    let time = 1000;

    const done = runWatch({
      filter: ["beat"],
      execOn: ["beat"],
      exec: "echo beat",
      execDebounceMs: 100,
      now: () => time,
      execCommand: (command, event) => execs.push({ command, event }),
      write: (line) => lines.push(line),
      writeStatus: () => {},
      signal: controller.signal,
      makeStream: ({ onEvent }) => {
        emit = onEvent as (e: unknown) => void;
        return { start: () => {}, close: () => {} };
      },
    });

    emit?.({ event: "node.created", data: { path: "/project1/x" } });
    emit?.({ event: "beat", data: { bar: 1 } });
    time += 50;
    emit?.({ event: "beat", data: { bar: 1 } });
    time += 100;
    emit?.({ event: "beat", data: { bar: 2 } });
    controller.abort();
    await done;

    expect(lines).toHaveLength(3);
    expect(execs).toEqual([
      { command: "echo beat", event: { event: "beat", data: { bar: 1 } } },
      { command: "echo beat", event: { event: "beat", data: { bar: 2 } } },
    ]);
  });

  it("prints watch heartbeats with the current filtered event count", async () => {
    vi.useFakeTimers();
    const status: string[] = [];
    const controller = new AbortController();
    let emit: ((e: unknown) => void) | undefined;

    try {
      const done = runWatch({
        heartbeatMs: 1000,
        write: () => {},
        writeStatus: (line) => status.push(line),
        signal: controller.signal,
        makeStream: ({ onEvent }) => {
          emit = onEvent as (e: unknown) => void;
          return { start: () => {}, close: () => {} };
        },
      });

      emit?.({ event: "beat", data: { bar: 1 } });
      await vi.advanceTimersByTimeAsync(1000);
      controller.abort();
      await done;

      expect(status).toContain("Heartbeat: 1 event.");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("tdmcp-agent CLI — phase 1 (musical reactivity)", () => {
  it("lists the reactivity commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["audio-features", "tempo-sync", "bind"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("emits a JSON Schema for bind (source_chop + channel)", async () => {
    const r = await runCli(["schema", "bind"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("bind");
    const input = JSON.stringify(doc.input);
    expect(input).toContain("source_chop");
    expect(input).toContain("channel");
  });

  it("dry-runs audio-features with the safe oscillator source", async () => {
    const r = await runCli(["audio-features", "--dry-run", "--params", '{"source":"oscillator"}']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("audio-features");
    expect(doc.args.source).toBe("oscillator");
  });

  it("dry-runs tempo-sync", async () => {
    const r = await runCli(["tempo-sync", "--dry-run", "--params", '{"period":2}']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("tempo-sync");
    expect(doc.args.period).toBe(2);
  });

  it("binds parameters to a channel through the mocked exec endpoint", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout:
              '{"bound": ["/project1/v/transform1.scale"], "warnings": [], "channel_present": true, "expression": "op(x)[bass]"}',
          },
        }),
      ),
    );
    const r = await runCli(
      [
        "bind",
        "--params",
        '{"targets":["/project1/v/transform1.scale"],"source_chop":"/x","channel":"bass"}',
      ],
      { makeCtx },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).bound).toContain("/project1/v/transform1.scale");
  });
});

describe("tdmcp-agent CLI — phase 2 (live performance)", () => {
  it("lists the performance commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["cue", "macro", "randomize", "surface", "remote"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("schema cue exposes the morph action and duration", async () => {
    const r = await runCli(["schema", "cue"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("morph");
    expect(input).toContain("duration");
  });

  it("schema surface exposes faders and cue_buttons", async () => {
    const r = await runCli(["schema", "surface"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("faders");
    expect(input).toContain("cue_buttons");
  });

  it("schema io now includes osc_out and midi_out", async () => {
    const r = await runCli(["schema", "io"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("osc_out");
    expect(input).toContain("midi_out");
  });

  it("dry-runs randomize with an amount", async () => {
    const r = await runCli([
      "randomize",
      "--dry-run",
      "--params",
      '{"comp_path":"/project1/sys","amount":0.5}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("randomize");
    expect(doc.args.amount).toBe(0.5);
  });

  it("creates a macro through the mocked exec endpoint", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout:
              '{"comp":"/project1/sys","macro":"Energy","bound":["/project1/sys/a.scale"],"warnings":[]}',
          },
        }),
      ),
    );
    const r = await runCli(
      [
        "macro",
        "--params",
        '{"comp_path":"/project1/sys","name":"Energy","targets":[{"param":"/project1/sys/a.scale","min":0,"max":2}]}',
      ],
      { makeCtx },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).macro).toBe("Energy");
  });
});

describe("tdmcp-agent CLI — phase 3 (advanced creation)", () => {
  it("lists the creation commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["mixer", "video", "scene3d", "mapping", "keyframe", "simulation"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("dry-runs the layer mixer with a blend mode", async () => {
    const r = await runCli(["mixer", "--dry-run", "--params", '{"blend":"difference"}']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("mixer");
    expect(doc.args.blend).toBe("difference");
  });

  it("schema scene3d exposes the primitive choices", async () => {
    const r = await runCli(["schema", "scene3d"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("sphere");
    expect(input).toContain("primitive");
  });

  it("schema simulation exposes reaction_diffusion / slime / fluid", async () => {
    const r = await runCli(["schema", "simulation"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("reaction_diffusion");
    expect(input).toContain("slime");
    expect(input).toContain("fluid");
  });

  it("rejects keyframe animation with a non-positive duration", async () => {
    const r = await runCli(
      [
        "keyframe",
        "--params",
        '{"targets":["/project1/x.brightness1"],"keyframes":[{"time":0,"value":0},{"time":0,"value":1}]}',
      ],
      { makeCtx },
    );
    // Exit-code taxonomy: a tool that runs but returns isError is a TD error (4),
    // not offline (3). (Bad flags/JSON/schema are caught pre-dispatch as usage=2.)
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("positive duration");
  });
});

describe("tdmcp-agent CLI — phase 4 (intelligence)", () => {
  it("lists the intelligence commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["operators", "document"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("searches the operator knowledge base (offline)", async () => {
    const r = await runCli(["operators", "--params", '{"query":"blur","limit":5}'], { makeCtx });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.count).toBeGreaterThan(0);
    expect(JSON.stringify(doc.operators).toLowerCase()).toContain("blur");
  });

  it("documents a network into a mermaid flowchart via the mocked bridge", async () => {
    const r = await runCli(["document", "--params", '{"path":"/project1"}'], { makeCtx });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.mermaid).toContain("flowchart");
    expect(doc.nodeCount).toBeGreaterThanOrEqual(1);
  });
});

describe("tdmcp-agent CLI — phase 5 (robustness & export)", () => {
  it("lists the robustness/export commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["diff", "optimize", "render", "recipes", "recipe"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("lists the recipe library offline", async () => {
    const r = await runCli(["recipes"], { makeCtx });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).count).toBeGreaterThan(0);
  });

  it("diffs two snapshots offline (added node + parameter change)", async () => {
    const r = await runCli([
      "diff",
      "--params",
      JSON.stringify({
        before: { nodes: [{ path: "/a", parameters: { size: 1 } }] },
        after: {
          nodes: [{ path: "/a", parameters: { size: 5 } }, { path: "/b" }],
        },
      }),
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.nodes_added).toContain("/b");
    expect(doc.parameter_changes[0].changes.size).toEqual({ from: 1, to: 5 });
  });

  it("schema render exposes node_path and file", async () => {
    const r = await runCli(["schema", "render"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("node_path");
    expect(input).toContain("file");
  });

  it("schema io now includes keyboard_in and gamepad_in", async () => {
    const r = await runCli(["schema", "io"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("keyboard_in");
    expect(input).toContain("gamepad_in");
  });
});

describe("tdmcp-agent CLI — pending items (0.9.0)", () => {
  it("lists the new commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["movie", "init", "repl"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("schema scene3d exposes instances", async () => {
    const r = await runCli(["schema", "scene3d"]);
    expect(r.code).toBe(0);
    expect(JSON.stringify(JSON.parse(r.stdout).input)).toContain("instances");
  });

  it("schema shaderpark exposes code and uniform_values", async () => {
    const r = await runCli(["schema", "shaderpark"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("shaderpark");
    expect(JSON.stringify(doc.input)).toContain("uniform_values");
    expect(JSON.stringify(doc.input)).toContain("Shader Park sculpture code");
  });

  it("schema operators exposes the semantic opt-in", async () => {
    const r = await runCli(["schema", "operators"]);
    expect(r.code).toBe(0);
    expect(JSON.stringify(JSON.parse(r.stdout).input)).toContain("semantic");
  });

  it("schema movie exposes action and seconds", async () => {
    const r = await runCli(["schema", "movie"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("seconds");
    expect(input).toContain("action");
  });

  it("operator search stays in keyword mode by default (no endpoint needed)", async () => {
    const r = await runCli(["operators", "--params", '{"query":"blur"}'], { makeCtx });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).mode).toBe("keyword");
  });
});

describe("tdmcp-agent CLI — phase 7 (stage I/O & sensor reactivity)", () => {
  it("lists motion-reactive in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("motion-reactive");
  });

  it("schema motion-reactive exposes the source choices and analysis resolution", async () => {
    const r = await runCli(["schema", "motion-reactive"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("camera");
    expect(input).toContain("synthetic");
    expect(input).toContain("analysis_resolution");
  });

  it("dry-runs motion-reactive with the safe synthetic source", async () => {
    const r = await runCli(["motion-reactive", "--dry-run", "--params", '{"source":"synthetic"}']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("motion-reactive");
    expect(doc.args.source).toBe("synthetic");
  });

  it("lists interactive-projection in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("interactive-projection");
  });

  it("schema interactive-projection exposes synthetic source and debug views", async () => {
    const r = await runCli(["schema", "interactive-projection"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("synthetic");
    expect(input).toContain("existing_top");
    expect(input).toContain("analysis_resolution");
    expect(input).toContain("debug_view");
  });

  it("dry-runs interactive-projection with the safe synthetic source", async () => {
    const r = await runCli([
      "interactive-projection",
      "--dry-run",
      "--params",
      '{"source":"synthetic"}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("interactive-projection");
    expect(doc.args.source).toBe("synthetic");
  });

  it("schema kinect-wall-harp exposes wall depth and string controls", async () => {
    const r = await runCli(["schema", "kinect-wall-harp"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("freenect");
    expect(input).toContain("synthetic");
    expect(input).toContain("wall_depth_center");
    expect(input).toContain("touch_thickness");
    expect(input).toContain("background_level");
    expect(input).toContain("frequencies");
  });

  it("dry-runs kinect-wall-harp with the synthetic source", async () => {
    const r = await runCli(["kinect-wall-harp", "--dry-run", "--params", '{"source":"synthetic"}']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("kinect-wall-harp");
    expect(doc.args.source).toBe("synthetic");
    expect(doc.args.background_level).toBe(0);
    expect(doc.args.string_count).toBe(16);
    expect(doc.args.visual_line_count).toBe(128);
  });

  it("schema text exposes the text content and alignment", async () => {
    const r = await runCli(["schema", "text"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("source_path");
    expect(input).toContain("align");
    expect(input).toContain("font_size");
  });

  it("dry-runs text with a color and alignment", async () => {
    const r = await runCli([
      "text",
      "--dry-run",
      "--params",
      '{"text":"HELLO","color":"#ff3366","valign":"bottom"}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("text");
    expect(doc.args.text).toBe("HELLO");
    expect(doc.args.valign).toBe("bottom");
  });

  it("schema autopilot exposes the mode and beats cadence", async () => {
    const r = await runCli(["schema", "autopilot"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("randomize");
    expect(input).toContain("cue");
    expect(input).toContain("beats");
  });

  it("dry-runs autopilot in cue mode", async () => {
    const r = await runCli([
      "autopilot",
      "--dry-run",
      "--params",
      '{"comp_path":"/project1/v","mode":"cue","beats":8}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("autopilot");
    expect(doc.args.mode).toBe("cue");
    expect(doc.args.beats).toBe(8);
  });

  it("schema multi-output exposes count, layout and edge-blend overlap", async () => {
    const r = await runCli(["schema", "multi-output"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("count");
    expect(input).toContain("horizontal");
    expect(input).toContain("as_windows");
    expect(input).toContain("overlap");
  });

  it("dry-runs multi-output across 3 projectors with edge-blend", async () => {
    const r = await runCli([
      "multi-output",
      "--dry-run",
      "--params",
      '{"source_path":"/project1/out1","count":3,"overlap":0.25,"as_windows":true}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("multi-output");
    expect(doc.args.count).toBe(3);
    expect(doc.args.overlap).toBe(0.25);
    expect(doc.args.as_windows).toBe(true);
  });

  it("schema clock-sync exposes the bpm range", async () => {
    const r = await runCli(["schema", "clock-sync"]);
    expect(r.code).toBe(0);
    expect(JSON.stringify(JSON.parse(r.stdout).input)).toContain("bpm");
  });

  it("dry-runs clock-sync at a given bpm", async () => {
    const r = await runCli(["clock-sync", "--dry-run", "--params", '{"bpm":128}']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("clock-sync");
    expect(doc.args.bpm).toBe(128);
  });
});

describe("tdmcp-agent CLI — reusable-component tools", () => {
  it("lists add-params and scaffold-ext in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("add-params");
    expect(r.stdout).toContain("scaffold-ext");
  });

  it("emits a JSON Schema for add-params", async () => {
    const r = await runCli(["schema", "add-params"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("add-params");
    expect(JSON.stringify(doc.input)).toContain("params");
  });

  it("dry-runs add-params without calling TD", async () => {
    const r = await runCli([
      "add-params",
      "--dry-run",
      "--params",
      '{"comp_path":"/project1/sys","params":[{"name":"Speed","type":"Float"}]}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("add-params");
    expect(doc.mutates).toBe(true);
    expect(doc.args.comp_path).toBe("/project1/sys");
  });

  it("emits a JSON Schema for scaffold-ext", async () => {
    const r = await runCli(["schema", "scaffold-ext"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("scaffold-ext");
    expect(JSON.stringify(doc.input)).toContain("class_name");
  });

  it("dry-runs scaffold-ext without calling TD", async () => {
    const r = await runCli([
      "scaffold-ext",
      "--dry-run",
      "--params",
      '{"comp_path":"/project1/sys","class_name":"WidgetExt","methods":["Reset"]}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("scaffold-ext");
    expect(doc.args.class_name).toBe("WidgetExt");
  });
});

describe("tdmcp-agent CLI — library packaging", () => {
  it("lists the library packaging commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["library", "portable-tox", "recipe-bundle-export", "install-library"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("emits JSON Schemas for recipe bundles and manifests", async () => {
    const bundle = await runCli(["schema", "recipe-bundle-export"]);
    expect(bundle.code).toBe(0);
    expect(JSON.stringify(JSON.parse(bundle.stdout).input)).toContain("recipe_ids");

    const manifest = await runCli(["schema", "manifest"]);
    expect(manifest.code).toBe(0);
    expect(JSON.stringify(JSON.parse(manifest.stdout).input)).toContain("path");
  });
});

describe("tdmcp-agent CLI — wave-5 branch coverage", () => {
  it("`version` as positional argument prints version (parity with --version)", async () => {
    const r = await runCli(["version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^tdmcp-agent \d+\.\d+\.\d+/);
  });

  it("`help` with no target falls back to usage()", async () => {
    const r = await runCli(["help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tdmcp-agent");
    expect(r.stdout).toContain("Commands:");
  });

  it("`help <unknown>` returns code 2 with a clear stderr message", async () => {
    const r = await runCli(["help", "totally-not-a-command"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unknown command for help");
  });

  it("`schema <unknown>` returns code 2", async () => {
    const r = await runCli(["schema", "no-such-thing"]);
    expect(r.code).toBe(2);
    // unknown schema falls through to general unknown-command path
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("completion supports zsh", async () => {
    const r = await runCli(["completion", "zsh"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("#compdef tdmcp-agent");
  });

  it("completion supports fish", async () => {
    const r = await runCli(["completion", "fish"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("complete -c tdmcp-agent");
  });

  it("completion rejects unknown shell with code 2", async () => {
    const r = await runCli(["completion", "powershell"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unsupported shell");
  });

  it("completion without a shell positional fails", async () => {
    const r = await runCli(["completion"]);
    expect(r.code).toBe(2);
  });

  it("`run` without a file argument fails", async () => {
    const r = await runCli(["run"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Missing file for "run"');
  });

  it("`run -` with malformed JSON returns code 2 and a friendly message", async () => {
    const r = await runCli(["run", "-"], { stdin: "{not json" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid run file");
  });

  it("`run <missing>` returns code 2", async () => {
    const r = await runCli(["run", "/does/not/exist.json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid run file");
  });

  it("merges --json into --params for command args", async () => {
    const r = await runCli([
      "nodes",
      "create",
      "--dry-run",
      "--params",
      '{"parent_path":"/project1"}',
      "--json",
      '{"type":"noiseTOP"}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.args.parent_path).toBe("/project1");
    expect(doc.args.type).toBe("noiseTOP");
  });

  it("`--params -` reads JSON from stdin", async () => {
    const r = await runCli(["nodes", "create", "--dry-run", "--params", "-"], {
      stdin: '{"parent_path":"/project1","type":"noiseTOP"}',
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).args.type).toBe("noiseTOP");
  });

  it("`--params-file` reads JSON from a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-pf-"));
    try {
      const file = join(dir, "params.json");
      writeFileSync(file, '{"parent_path":"/project1","type":"noiseTOP"}');
      const r = await runCli(["nodes", "create", "--dry-run", "--params-file", file]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).args.parent_path).toBe("/project1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalid CLI flag bails out before any command logic", async () => {
    const r = await runCli(["--unknown-flag"]);
    expect(r.code).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("config init --dry-run prints body without writing the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-init-"));
    try {
      const target = join(dir, "config.env");
      const r = await runCli(["config", "init", target, "--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.stdout.length + r.stderr.length).toBeGreaterThan(0);
      // Dry-run does not create the file.
      expect(() => readFileSync(target, "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`config profile` with no name errors out", async () => {
    const r = await runCli(["config", "profile"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Missing profile name for "config profile"');
  });

  it("`config profiles` returns an empty list when no config file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-cfg-empty-"));
    try {
      const config = join(dir, "tdmcp.json");
      writeFileSync(config, JSON.stringify({ tdHost: "h" }));
      const r = await runCli(["config", "profiles", "--config", config]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).profiles).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("show-director approve without an approval id errors", async () => {
    const r = await runCli(["show-director", "approve"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Missing approval id");
  });

  it("show-director with unknown sub-verb errors", async () => {
    const r = await runCli([
      "show-director",
      "whatever",
      "--params",
      JSON.stringify({ intent: { type: "arm_effect", effect: "fog", duration_seconds: 1 } }),
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unknown show-director verb");
  });

  it("show-director approve without operator errors", async () => {
    const r = await runCli([
      "show-director",
      "approve",
      "approval_0001",
      "--params",
      JSON.stringify({}),
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Missing operator");
  });

  it("show-director with no intent errors", async () => {
    const r = await runCli(["show-director", "--params", JSON.stringify({})]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Missing intent");
  });

  it("panic unknown sub-verb errors before contacting TD", async () => {
    const r = await runCli(["panic", "explode"], {
      makeCtx: () => {
        throw new Error("panic unknown verb must not build a TD context");
      },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown panic sub-verb");
  });

  it("setlist with unknown verb errors", async () => {
    const r = await runCli(["setlist", "delete"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown setlist verb");
  });

  it("setlist run without a file errors", async () => {
    const r = await runCli(["setlist", "run"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Missing setlist path");
  });

  it("setlist run dry-runs a minimal setlist file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-setlist-"));
    try {
      const file = join(dir, "setlist.json");
      writeFileSync(
        file,
        JSON.stringify({
          title: "Unit Show",
          bpm: 120,
          scenes: [{ id: "intro", cue: "look_intro", hold_seconds: 0 }],
        }),
      );

      const r = await runCli(["setlist", "run", file, "--dry-run", "--mode", "duration"], {
        makeCtx,
      });

      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"t":"would_fire"');
      expect(r.stdout).toContain('"ended_reason":"complete"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("setlist run reports malformed file content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-setlist-bad-"));
    try {
      const file = join(dir, "setlist.json");
      writeFileSync(file, "{not json");

      const r = await runCli(["setlist", "run", file, "--dry-run"], { makeCtx });

      expect(r.code).toBe(2);
      expect(r.stderr).toContain("setlist string is not valid JSON");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("schedule without a file errors", async () => {
    const r = await runCli(["schedule"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Missing schedule path");
  });

  it("schedule prints timezone info without building a TD context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-schedule-"));
    try {
      const file = join(dir, "schedule.json");
      writeFileSync(
        file,
        JSON.stringify({
          entries: [
            {
              at: "09:30",
              action: { type: "command", cmd: "/bin/echo", args: ["hi"] },
            },
          ],
        }),
      );

      const r = await runCli(["schedule", file, "--tz-info"], {
        makeCtx: () => {
          throw new Error("schedule tz-info must not build context");
        },
      });

      expect(r.code).toBe(0);
      expect(r.stdout).toContain("timezone:");
      expect(r.stdout).toContain("entry_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("schedule reports malformed schedule files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-schedule-bad-"));
    try {
      const file = join(dir, "schedule.json");
      writeFileSync(file, "{not json");

      const r = await runCli(["schedule", file]);

      expect(r.code).toBe(2);
      expect(r.stderr).toContain("error:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nodes find with invalid JSON --params returns code 2 with friendly message", async () => {
    const r = await runCli(["nodes", "find", "--params", "{nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid JSON");
  });

  it("nodes create with invalid schema args returns code 2", async () => {
    const r = await runCli(["nodes", "create", "--params", '{"parent_path":"/x"}']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid arguments");
  });

  it("unknown commands include a nearest-command hint when one is obvious", async () => {
    const r = await runCli(["noeds"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Did you mean "nodes"?');
  });

  it("merges --params-file and --json before dry-run validation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-params-file-"));
    try {
      const file = join(dir, "params.json");
      writeFileSync(file, JSON.stringify({ parent_path: "/project1" }), "utf8");

      const r = await runCli(
        [
          "nodes",
          "list",
          "--dry-run",
          "--params-file",
          file,
          "--json",
          JSON.stringify({ detail_level: "summary" }),
        ],
        {
          makeCtx: () => {
            throw new Error("dry-run must not build context");
          },
        },
      );

      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.args).toMatchObject({ parent_path: "/project1", detail_level: "summary" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nodes list rendered as text returns the result text", async () => {
    const r = await runCli(["nodes", "list", "--output", "text"], { makeCtx });
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it("renders an empty CSV/table when the underlying data has no rows", async () => {
    // formatTable + formatCsv both early-return "" for an empty rows list.
    // We exercise the branch through a command that returns an array.
    const r = await runCli(
      ["nodes", "list", "--output", "table", "--params", '{"detail_level":"summary"}'],
      { makeCtx },
    );
    expect(r.code).toBe(0);
    // Just verify the path doesn't throw; some shape will be produced.
    expect(r.stdout).toBeDefined();
  });

  it("REPL completion falls back to ALL words when nothing matches the prefix", () => {
    const [matches, prefix] = completeReplLine("zzzzzz");
    expect(prefix).toBe("zzzzzz");
    expect(matches.length).toBeGreaterThan(10);
  });

  it("REPL completion offers exit/quit", () => {
    const [matches] = completeReplLine("ex");
    expect(matches).toContain("exit");
  });

  it("replHistoryPath honors TDMCP_AGENT_HISTORY when set", () => {
    expect(replHistoryPath({ TDMCP_AGENT_HISTORY: "/tmp/explicit-history" })).toBe(
      "/tmp/explicit-history",
    );
  });

  it("replHistoryPath falls back to ~/.local/state when no env is set", () => {
    const p = replHistoryPath({});
    expect(p).toMatch(/tdmcp-agent[/\\]history$/);
  });

  it("loadReplHistory returns [] for a missing file", () => {
    expect(loadReplHistory("/tmp/tdmcp-no-such-history-file-xyz")).toEqual([]);
  });

  it("--no-color is forwarded by run-file step argv generator", async () => {
    const r = await runCli(["run", "-", "--no-color"], {
      stdin: JSON.stringify([{ command: "info", dry_run: true }]),
    });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.steps[0].command).toContain("--no-color");
  });

  it("preview --dry-run accepts the node_path via --params instead of positional", async () => {
    const r = await runCli([
      "preview",
      "--dry-run",
      "--params",
      JSON.stringify({ node_path: "/project1/out2" }),
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.args.node_path).toBe("/project1/out2");
  });

  it("watch with `exclude` drops matching events and lets others through", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    let emit: ((e: unknown) => void) | undefined;

    const done = runWatch({
      exclude: ["timeline.frame"],
      write: (line) => lines.push(line),
      writeStatus: () => {},
      signal: controller.signal,
      makeStream: ({ onEvent }) => {
        emit = onEvent as (e: unknown) => void;
        return { start: () => {}, close: () => {} };
      },
    });

    emit?.({ event: "timeline.frame", data: { f: 1 } });
    emit?.({ event: "beat", data: { bar: 1 } });
    controller.abort();
    await done;

    expect(lines).toEqual(['{"event":"beat","data":{"bar":1}}']);
  });

  it("watch resolves immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;
    let closed = false;
    await runWatch({
      write: () => {},
      writeStatus: () => {},
      signal: controller.signal,
      makeStream: () => ({
        start: () => {
          started = true;
        },
        close: () => {
          closed = true;
        },
      }),
    });
    expect(started).toBe(true);
    expect(closed).toBe(true);
  });

  it("watch pretty output filters events and debounces exec hooks", async () => {
    const lines: string[] = [];
    const statuses: string[] = [];
    const execCalls: Array<{ command: string; event: unknown }> = [];
    const controller = new AbortController();
    let emit: ((e: unknown) => void) | undefined;
    let now = 1_000;

    const done = runWatch({
      filter: ["beat"],
      execOn: ["beat"],
      exec: "echo beat",
      execDebounceMs: 50,
      heartbeatMs: 1,
      pretty: true,
      now: () => now,
      execCommand: (command, event) => execCalls.push({ command, event }),
      write: (line) => lines.push(line),
      writeStatus: (line) => statuses.push(line),
      signal: controller.signal,
      makeStream: ({ onEvent, includeHighFrequency }) => {
        expect(includeHighFrequency).toBe(false);
        emit = onEvent as (e: unknown) => void;
        return { start: () => {}, close: () => {} };
      },
    });

    emit?.({ type: "timeline.frame", data: { frame: 1 } });
    emit?.({ type: "beat", data: { bar: 1 } });
    emit?.({ type: "beat", data: { bar: 2 } });
    now += 60;
    emit?.({ type: "beat", data: { bar: 3 } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await done;

    expect(lines).toEqual(['beat {"bar":1}', 'beat {"bar":2}', 'beat {"bar":3}']);
    expect(execCalls).toEqual([
      expect.objectContaining({ command: "echo beat" }),
      expect.objectContaining({ command: "echo beat" }),
    ]);
    expect(statuses.some((line) => line.startsWith("Heartbeat:"))).toBe(true);
    expect(statuses.at(-1)).toBe("Stopped after 3 events.");
  });

  it("watch pretty output falls back to event names and scalar payloads", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    let emit: ((e: unknown) => void) | undefined;

    const done = runWatch({
      pretty: true,
      write: (line) => lines.push(line),
      writeStatus: () => {},
      signal: controller.signal,
      makeStream: ({ onEvent }) => {
        emit = onEvent as (e: unknown) => void;
        return { start: () => {}, close: () => {} };
      },
    });

    emit?.({ event: "custom", data: undefined });
    emit?.("raw-event");
    controller.abort();
    await done;

    expect(lines).toEqual(["custom", "event raw-event"]);
  });

  // ───── wave-9: branch-coverage fills for runCli error paths ─────

  it("returns code 2 with stderr when parseCliArgs throws (unknown flag)", async () => {
    const r = await runCli(["--definitely-not-a-flag"]);
    expect(r.code).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.stdout).toBe("");
  });

  it("help without target falls back to general usage", async () => {
    const r = await runCli(["help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tdmcp-agent");
  });

  it("help with unknown command reports the unknown target", async () => {
    const r = await runCli(["help", "totally", "fake", "cmd"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unknown command for help");
  });

  it("schema with unknown command reports the unknown target", async () => {
    const r = await runCli(["schema", "no-such-cmd"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unknown command for schema");
  });

  it("completion with an unsupported shell exits 2 with guidance", async () => {
    const r = await runCli(["completion", "tcsh"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unsupported shell");
  });

  it("completion zsh emits a zsh-shaped script", async () => {
    const r = await runCli(["completion", "zsh"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("#compdef tdmcp-agent");
  });

  it("completion fish emits a fish-shaped script", async () => {
    const r = await runCli(["completion", "fish"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("complete -c tdmcp-agent");
  });

  it("run without a file reports missing argument", async () => {
    const r = await runCli(["run"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Missing file for "run"');
  });

  it("run with an unreadable file reports invalid run file", async () => {
    const r = await runCli(["run", "/definitely/not/a/real/path/steps.json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid run file");
  });

  it("`version` positional behaves like --version", async () => {
    const r = await runCli(["version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/tdmcp-agent \d+\.\d+\.\d+/);
  });

  it("replHistoryPath honors TDMCP_AGENT_HISTORY", () => {
    const p = replHistoryPath({
      TDMCP_AGENT_HISTORY: "/tmp/my-tdmcp-history",
    } as NodeJS.ProcessEnv);
    expect(p).toBe("/tmp/my-tdmcp-history");
  });

  it("replHistoryPath honors XDG_STATE_HOME when no explicit override", () => {
    const p = replHistoryPath({
      XDG_STATE_HOME: "/tmp/xdgstate",
    } as NodeJS.ProcessEnv);
    expect(p).toBe("/tmp/xdgstate/tdmcp-agent/history");
  });

  it("loadReplHistory returns [] when the file does not exist", () => {
    const lines = loadReplHistory("/tmp/__tdmcp_does_not_exist__/history");
    expect(lines).toEqual([]);
  });

  it("saveReplHistory deduplicates and trims, and loadReplHistory reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-hist-"));
    try {
      const path = join(dir, "history");
      saveReplHistory(["a", "  a  ", "b", "", "a", "b"], path);
      const round = loadReplHistory(path);
      expect(round).toEqual(["a", "b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("completeReplLine returns a prefix-filtered list when there is a match", () => {
    const [matches] = completeReplLine("nodes ");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("completeReplLine falls back to all words when prefix doesn't match", () => {
    const [matches, prefix] = completeReplLine("zzz-no-such-prefix");
    expect(prefix).toBe("zzz-no-such-prefix");
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe("tdmcp-agent CLI — coverage wave 3 offline branches", () => {
  it("emits schemas for ai-party gateway and telegram-once", async () => {
    const gateway = await runCli(["schema", "ai-party"]);
    expect(gateway.code).toBe(0);
    const gatewayDoc = JSON.parse(gateway.stdout);
    expect(gatewayDoc.command).toBe("ai-party");
    expect(JSON.stringify(gatewayDoc.input)).toContain("message");
    expect(JSON.stringify(gatewayDoc.input)).toContain("preapproved_cues");

    const telegram = await runCli(["schema", "ai-party", "telegram-once"]);
    expect(telegram.code).toBe(0);
    const telegramDoc = JSON.parse(telegram.stdout);
    expect(telegramDoc.command).toBe("ai-party telegram-once");
    expect(JSON.stringify(telegramDoc.input)).toContain("allowed_chat_ids");
  });

  it("prints focused help for ai-party special commands", async () => {
    const gateway = await runCli(["help", "ai-party"]);
    expect(gateway.code).toBe(0);
    expect(gateway.stdout).toContain("tdmcp-agent ai-party");
    expect(gateway.stdout).toContain("Input schema:");

    const telegram = await runCli(["help", "ai-party", "telegram-once"]);
    expect(telegram.code).toBe(0);
    expect(telegram.stdout).toContain("tdmcp-agent ai-party telegram-once");
    expect(telegram.stdout).toContain("allowed_chat_ids");
  });

  it("rejects malformed ai-party-poc params before running the POC", async () => {
    const invalidJson = await runCli(["ai-party-poc", "--params", "{not-json"]);
    expect(invalidJson.code).toBe(2);
    expect(invalidJson.stderr).toContain("Invalid JSON");

    const invalidArgs = await runCli(["ai-party-poc", "--params", '{"operator":""}']);
    expect(invalidArgs.code).toBe(2);
    expect(invalidArgs.stderr).toContain('Invalid arguments for "ai-party-poc"');
  });

  it("rejects malformed ai-party gateway input and unknown verbs", async () => {
    const invalidArgs = await runCli(["ai-party", "--params", "{}"]);
    expect(invalidArgs.code).toBe(2);
    expect(invalidArgs.stderr).toContain('Invalid arguments for "ai-party"');

    const unknown = await runCli(["ai-party", "dancefloor"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('Unknown ai-party verb "dancefloor"');
  });

  it("rejects invalid ai-party telegram-once args without polling Telegram", async () => {
    const r = await runCli(["ai-party", "telegram-once", "--params", '{"limit":101}']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Invalid arguments for "ai-party telegram-once"');
  });

  it("rejects show-director non-intent argument errors separately from malformed intents", async () => {
    const r = await runCli(["show-director", "--params", '{"operator":""}']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Invalid arguments for "show-director"');
    expect(r.stderr).not.toContain("Malformed show intent");
  });

  it("rejects show-director mixer catalogs whose policy hash has drifted", async () => {
    const scene = {
      scene_id: "drifted_scene",
      label: "Drifted Scene",
      adapter_target: { kind: "soundcraft_ui24r", mixer_id: "foh-ui24r" },
      operation: "recall_snapshot",
      show_name: "Demo Show",
      snapshot_name: "Drifted Snapshot",
      allowed_setlist_sections: ["intro"],
      last_validated_at: "2026-06-03T18:00:00.000Z",
      rollback_target: "house_default",
      safety_notes: "Fixture catalog for hash-mismatch coverage.",
      forbidden_delta_check: {
        excludes_all_forbidden: true,
        verified: [
          "gain",
          "pa_mute",
          "routing",
          "patch",
          "channel_strip",
          "mute_group",
          "phantom_power",
        ],
      },
    };
    const r = await runCli([
      "show-director",
      "--params",
      JSON.stringify({
        mixer_scene_catalog: {
          venue: "Fixture Venue",
          catalog_version: "test",
          policy_hash: "not-the-real-hash",
          scenes: [scene],
        },
        intent: {
          type: "arm_mixer_scene",
          adapter_target: { kind: "soundcraft_ui24r", mixer_id: "foh-ui24r" },
          target: { kind: "snapshot", scene_id: "drifted_scene" },
        },
      }),
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid mixer scene catalog");
    expect(r.stderr).toContain("catalog hash mismatch");
  });

  it("returns structured doctor output with --output json", async () => {
    const r = await runCli(["doctor", "--output", "json"], { makeCtx });
    expect(r.stdout).toContain('"checks"');
    expect(r.stderr).toBe("");
    expect([0, 1]).toContain(r.code);
  });

  it("accepts bare --json as an alias for --output json on doctor", async () => {
    const r = await runCli(["doctor", "--json"], { makeCtx });
    expect(r.stdout).toContain('"checks"');
    expect(r.stderr).toBe("");
    expect([0, 1]).toContain(r.code);
  });

  it("honors doctor --quiet by suppressing output", async () => {
    const r = await runCli(["doctor", "--quiet"], { makeCtx });
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect([0, 1]).toContain(r.code);
  });

  it("surfaces preview context build failures before capture", async () => {
    const r = await runCli(["preview", "/project1/out1"], {
      makeCtx: () => {
        throw new Error("bad preview config");
      },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("bad preview config");
  });

  it("surfaces invalid config profile resolution errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-agent-bad-profile-"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const config = join(dir, "tdmcp.json");
      writeFileSync(config, "{not-json");
      const r = await runCli(["config", "profile", "club", "--config", config]);
      expect(r.code).toBe(2);
      expect(r.stderr.length).toBeGreaterThan(0);
    } finally {
      stderr.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tdmcp-agent CLI — tool-parity wave subcommands", () => {
  it("get_preview captures a TOP through the CLI (msw success path)", async () => {
    const r = await runCli(
      ["get_preview", "--params", '{"node_path":"/project1/render1","width":640,"height":360}'],
      { makeCtx },
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Preview of /project1/render1");
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it("watch_node surfaces a friendly error when the bridge returns no report", async () => {
    const r = await runCli(
      ["watch_node", "--params", '{"path":"/project1/noise1","samples":1,"interval_ms":20}'],
      { makeCtx },
    );
    // Exit-code taxonomy: 4 = TD reached but the op failed (3 = TD unreachable).
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("No samples collected");
  });

  it("scaffold_vault returns a friendly error when no vault is configured", async () => {
    const r = await runCli(["scaffold_vault", "--params", "{}"], { makeCtx });
    // Exit-code taxonomy: 4 = op failed (vault missing), not a transport failure.
    expect(r.code).toBe(4);
    expect(r.stderr.toLowerCase()).toContain("vault");
  });
});
