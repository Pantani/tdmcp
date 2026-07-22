import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  COPILOT_CALIBRATE_HELP,
  parseCopilotCalibrateArgs,
  runCopilotCalibrate,
} from "../../src/cli/copilotCalibrate.js";
import type { CalibrationModelClient } from "../../src/llm/calibration.js";
import {
  CALIBRATION_SUITE_VERSION,
  CalibrationManifestSchema,
  type CalibrationRunResult,
  calibrationEndpointIdentity,
  calibrationFingerprint,
} from "../../src/llm/calibration.js";
import { loadConfig } from "../../src/utils/config.js";

const identity = {
  endpoint_identity: calibrationEndpointIdentity("http://127.0.0.1:11434/v1"),
  provider: "ollama" as const,
  model: "fixture-model",
  digest: "fixture-digest",
  stable_build: true,
};

function result(
  termination: CalibrationRunResult["termination"] = "completed",
): CalibrationRunResult {
  const capabilities = [
    "schema_adherence",
    "tool_selection",
    "sequential_calls",
    "parallel_calls",
    "failed_call_recovery",
    "context_budget",
    "image_input",
  ].map((id) => ({
    id,
    status: id === "image_input" ? ("UNVERIFIED" as const) : ("PASS" as const),
    samples:
      id === "image_input"
        ? { total: 1, passed: 0, failed: 0, unverified: 1 }
        : { total: 3, passed: 3, failed: 0, unverified: 0 },
    reason_codes: [id === "image_input" ? "vision_unsupported" : "pass"],
  }));
  const manifest = CalibrationManifestSchema.parse({
    schema_version: 1,
    suite_version: CALIBRATION_SUITE_VERSION,
    status: "PASS",
    source: "fresh",
    started_at: "2026-07-15T12:00:00.000Z",
    completed_at: "2026-07-15T12:00:01.000Z",
    duration_ms: 1_000,
    mode: "recommend",
    identity,
    fingerprint: calibrationFingerprint(identity),
    samples_per_capability: 3,
    capabilities,
    recommended_max_tier: "creative",
    requested_tier: "standard",
    effective_tier: "standard",
    policy_reason: "recommend_within_calibrated_cap",
    cache: { used: false, reusable_for_mutation: true, write: "disabled" },
  });
  return { manifest, warnings: ["fixture_warning"], termination, requestCount: 24 };
}

const unusedClient = {
  chatStream: vi.fn(async () => {
    throw new Error("CLI unit test must not contact a model");
  }),
} satisfies CalibrationModelClient;

describe("parseCopilotCalibrateArgs", () => {
  it("parses every bounded operator flag", () => {
    expect(
      parseCopilotCalibrateArgs([
        "--mode",
        "enforce",
        "--samples",
        "5",
        "--timeout",
        "5000",
        "--vision",
        "required",
        "--refresh",
        "--no-cache",
        "--cache",
        "/tmp/calibration.json",
        "--model",
        "qwen-fixture",
        "--profile",
        "studio",
        "--config",
        "/tmp/tdmcp.json",
        "--json",
      ]),
    ).toMatchObject({
      mode: "enforce",
      samples: 5,
      timeoutMs: 5_000,
      vision: "required",
      refresh: true,
      noCache: true,
      cachePath: "/tmp/calibration.json",
      model: "qwen-fixture",
      profile: "studio",
      configPath: "/tmp/tdmcp.json",
      json: true,
    });
  });

  it("rejects bad enums, bounds, relative cache paths, positionals, and unknown flags", () => {
    expect(() => parseCopilotCalibrateArgs(["--mode", "maybe"])).toThrow(/mode/u);
    expect(() => parseCopilotCalibrateArgs(["--samples", "2"])).toThrow(/samples/u);
    expect(() => parseCopilotCalibrateArgs(["--timeout", "4999"])).toThrow(/timeout/u);
    expect(() => parseCopilotCalibrateArgs(["--vision", "maybe"])).toThrow(/vision/u);
    expect(() => parseCopilotCalibrateArgs(["--cache", "relative.json"])).toThrow(/absolute/u);
    expect(() => parseCopilotCalibrateArgs(["unexpected"])).toThrow(/positional/u);
    expect(() => parseCopilotCalibrateArgs(["--api-key", "secret"])).toThrow(/Unknown/u);
  });
});

describe("runCopilotCalibrate", () => {
  it("prints help without loading config or probing any endpoint", async () => {
    const load = vi.fn(() => loadConfig({}));
    const calibrate = vi.fn();
    let stdout = "";
    const code = await runCopilotCalibrate(["--help"], {
      loadConfig: load,
      runCalibration: calibrate,
      writeStdout: (chunk) => {
        stdout += chunk;
      },
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdout).toContain(COPILOT_CALIBRATE_HELP);
    expect(load).not.toHaveBeenCalled();
    expect(calibrate).not.toHaveBeenCalled();
  });

  it("emits exactly one JSON manifest line and keeps warnings on stderr", async () => {
    let stdout = "";
    let stderr = "";
    let capturedOptions: unknown;
    const code = await runCopilotCalibrate(["--json", "--model", "fixture-model", "--no-cache"], {
      env: {},
      loadConfig: (env, options) => loadConfig(env, options),
      createClient: () => unusedClient,
      runCalibration: async (options) => {
        capturedOptions = options;
        return result();
      },
      writeStdout: (chunk) => {
        stdout += chunk;
      },
      writeStderr: (chunk) => {
        stderr += chunk;
      },
    });
    expect(code).toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout).fingerprint).toMatch(/^sha256:/u);
    expect(stderr).toContain("fixture_warning");
    expect(capturedOptions).toMatchObject({
      endpoint: "http://127.0.0.1:11434/v1",
      model: "fixture-model",
      noCache: true,
      mode: "recommend",
      requestedTier: "standard",
    });
    expect(JSON.stringify(capturedOptions)).not.toContain("tdHost");
  });

  it.each([
    ["completed", 0],
    ["vision_required_failed", 1],
    ["failed", 1],
    ["endpoint_unreachable", 3],
    ["model_unavailable", 3],
    ["timeout", 124],
    ["aborted", 124],
  ] as const)("maps %s to exit %i", async (termination, expected) => {
    const code = await runCopilotCalibrate([], {
      env: {},
      loadConfig: () => loadConfig({}),
      createClient: () => unusedClient,
      runCalibration: async () => result(termination),
      writeStdout: () => {},
      writeStderr: () => {},
    });
    expect(code).toBe(expected);
  });

  it("returns usage code 2 without loading config", async () => {
    const load = vi.fn(() => loadConfig({}));
    let stderr = "";
    const code = await runCopilotCalibrate(["--samples", "99"], {
      loadConfig: load,
      writeStdout: () => {},
      writeStderr: (chunk) => {
        stderr += chunk;
      },
    });
    expect(code).toBe(2);
    expect(stderr).toContain("--samples");
    expect(load).not.toHaveBeenCalled();
  });

  it("has no production dispatch, bridge, or model-start dependency", () => {
    const source = readFileSync("src/cli/copilotCalibrate.ts", "utf8");
    expect(source).not.toMatch(
      /TouchDesignerClient|ToolContext|ensureOllamaUp|dispatchTool|runAgentTurn/u,
    );
    expect(source).not.toMatch(/\.pull\(/u);
  });
});
