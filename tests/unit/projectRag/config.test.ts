import { describe, expect, it } from "vitest";
import { toProjectRagConfig } from "../../../src/projectRag/index.js";
import { loadConfig } from "../../../src/utils/config.js";

describe("projectRag config — defaults + env overrides", () => {
  it("default flags: projectRagEnabled true, bridgeAnalysis false, bridgePort 9981", () => {
    const cfg = loadConfig({});
    expect(cfg.projectRagEnabled).toBe(true);
    expect(cfg.projectRagBridgeAnalysis).toBe(false);
    expect(cfg.projectRagBridgePort).toBe(9981);
    expect(cfg.projectRagAnalyzeTimeoutMs).toBe(30000);
    expect(cfg.projectRagLicenseAllowlist).toContain("MIT");
    expect(cfg.projectRagLicenseAllowlist).toContain("CC0");
  });

  it("toProjectRagConfig — enabled requires BOTH ragEnabled AND projectRagEnabled", () => {
    expect(toProjectRagConfig(loadConfig({})).enabled).toBe(false); // ragEnabled default false
    expect(toProjectRagConfig(loadConfig({ TDMCP_RAG_ENABLED: "1" })).enabled).toBe(true);
    expect(
      toProjectRagConfig(loadConfig({ TDMCP_RAG_ENABLED: "1", TDMCP_PROJECT_RAG_ENABLED: "0" }))
        .enabled,
    ).toBe(false);
    expect(
      toProjectRagConfig(loadConfig({ TDMCP_RAG_ENABLED: "0", TDMCP_PROJECT_RAG_ENABLED: "1" }))
        .enabled,
    ).toBe(false);
  });

  it("dataDir maps to <ragDataDir>/project (isolated from creative cards)", () => {
    const pcfg = toProjectRagConfig(loadConfig({ TDMCP_RAG_DATA_DIR: "/tmp/foo" }));
    expect(pcfg.dataDir).toBe("/tmp/foo/project");
    const default_ = toProjectRagConfig(loadConfig({}));
    expect(default_.dataDir.endsWith("/project")).toBe(true);
    expect(default_.dataDir).not.toEqual(loadConfig({}).ragDataDir);
  });

  it("score weights parse from CSV env (colon-separated)", () => {
    const cfg = loadConfig({ TDMCP_PROJECT_RAG_SCORE_WEIGHTS: "0.5:0.2:0.2:0.1" });
    expect(cfg.projectRagScoreWeights).toEqual({
      technical: 0.5,
      license: 0.2,
      freshness: 0.2,
      reliability: 0.1,
    });
  });

  it("bridge port can be overridden via env", () => {
    const cfg = loadConfig({ TDMCP_PROJECT_RAG_BRIDGE_PORT: "9990" });
    expect(cfg.projectRagBridgePort).toBe(9990);
  });
});
