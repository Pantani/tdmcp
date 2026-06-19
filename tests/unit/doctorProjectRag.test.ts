import { describe, expect, it, vi } from "vitest";
import type { DoctorCheck } from "../../src/cli/doctor.js";
import {
  checkProjectRag,
  projectRagIndexPath,
  runProjectRagChecks,
  suggestFixProjectRag,
} from "../../src/cli/doctorProjectRag.js";
import { loadConfig, type TdmcpConfig } from "../../src/utils/config.js";

function makeConfig(overrides: Partial<TdmcpConfig> = {}): TdmcpConfig {
  return {
    ...loadConfig({}),
    ragEnabled: true,
    projectRagEnabled: false,
    ragDataDir: ".tdmcp/creative-rag",
    ...overrides,
  };
}

describe("projectRagIndexPath", () => {
  it("resolves to <ragDataDir>/project/index.jsonl", () => {
    const path = projectRagIndexPath(makeConfig());
    expect(path.endsWith(`${"project"}/index.jsonl`) || path.includes("project")).toBe(true);
    expect(path).toMatch(/project[/\\]index\.jsonl$/);
  });
});

describe("enabled", () => {
  it("passes without touching fs when both gating flags are on", () => {
    const indexSize = vi.fn();
    const check = checkProjectRag(makeConfig({ ragEnabled: true, projectRagEnabled: true }), {
      indexSize,
    });
    expect(check.status).toBe("pass");
    expect(check.data?.enabled).toBe(true);
    expect(indexSize).not.toHaveBeenCalled();
  });

  it("treats master RAG gate off as disabled even if projectRagEnabled defaults true", () => {
    const check = checkProjectRag(makeConfig({ ragEnabled: false, projectRagEnabled: true }), {
      indexSize: () => 4096,
    });
    expect(check.status).toBe("warn");
    expect(check.data?.offFlag).toBe("TDMCP_RAG_ENABLED");
    expect(check.detail).toContain("TDMCP_RAG_ENABLED is off");
  });
});

describe("disabled, no index", () => {
  it("passes (skipped) when no index file exists", () => {
    const check = checkProjectRag(makeConfig(), { indexSize: () => null });
    expect(check.status).toBe("pass");
    expect(check.data?.enabled).toBe(false);
    expect(check.data?.indexFound).toBe(false);
    expect(check.detail).toContain("skipped");
  });

  it("passes (skipped) when the index file is zero bytes", () => {
    const check = checkProjectRag(makeConfig(), { indexSize: () => 0 });
    expect(check.status).toBe("pass");
    expect(check.data?.indexFound).toBe(false);
  });
});

describe("disabled, dormant index", () => {
  it("warns when a non-empty index exists but the flag is off", () => {
    const check = checkProjectRag(makeConfig(), { indexSize: () => 1234 });
    expect(check.status).toBe("warn");
    expect(check.data?.indexFound).toBe(true);
    expect(check.data?.indexBytes).toBe(1234);
    expect(check.detail).toContain("TDMCP_PROJECT_RAG_ENABLED is off");
    expect(typeof check.data?.indexPath).toBe("string");
  });
});

describe("probe I/O error", () => {
  it("warns (never throws) when the index probe raises a non-ENOENT error", () => {
    const check = checkProjectRag(makeConfig(), {
      indexSize: () => {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
    });
    expect(check.status).toBe("warn");
    expect(check.data?.errorCode).toBe("EACCES");
    expect(check.data?.indexFound).toBe(false);
    expect(check.detail).toContain("EACCES");
  });
});

describe("runProjectRagChecks", () => {
  it("returns exactly one check, never critical", () => {
    const checks = runProjectRagChecks(makeConfig(), { indexSize: () => 1 });
    expect(checks).toHaveLength(1);
    expect(checks[0]?.id).toBe("project_rag");
    expect(checks[0]?.critical).toBe(false);
  });
});

describe("suggestFixProjectRag", () => {
  const config = makeConfig();

  it("returns the enable hint for a warn", () => {
    const check: DoctorCheck = {
      id: "project_rag",
      title: "Project RAG — status",
      status: "warn",
      detail: "dormant",
      critical: false,
    };
    expect(suggestFixProjectRag(check, config)).toContain("TDMCP_PROJECT_RAG_ENABLED=1");
  });

  it("returns undefined for pass", () => {
    const check: DoctorCheck = {
      id: "project_rag",
      title: "Project RAG — status",
      status: "pass",
      detail: "ok",
      critical: false,
    };
    expect(suggestFixProjectRag(check, config)).toBeUndefined();
  });

  it("returns undefined for an unknown id", () => {
    const check: DoctorCheck = {
      id: "other",
      title: "x",
      status: "warn",
      detail: "y",
      critical: false,
    };
    expect(suggestFixProjectRag(check, config)).toBeUndefined();
  });
});
