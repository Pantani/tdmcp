import { describe, expect, it, vi } from "vitest";
import { runTopLevelDoctor, type TopLevelDoctorDeps } from "../../src/cli/topLevelDoctor.js";
import { loadConfig } from "../../src/utils/config.js";

function deps(code = 0): TopLevelDoctorDeps {
  return {
    env: {},
    cwd: "/tmp/project",
    loadConfig: vi.fn(() => loadConfig({})),
    runDoctor: vi.fn(async () => ({
      stdout: "doctor text\n",
      stderr: code === 0 ? "" : "offline\n",
      code,
      report: {
        ok: code === 0,
        checks: [],
        config: {
          tdBaseUrl: "http://127.0.0.1:9980",
          llmBaseUrl: "http://127.0.0.1:11434/v1",
          llmModel: "model",
          chatPort: 3260,
          vaultPath: null,
        },
      },
    })),
  };
}

describe("runTopLevelDoctor", () => {
  it("runs the existing environment doctor and preserves its exit code", async () => {
    const injected = deps(1);
    const result = await runTopLevelDoctor([], injected);
    expect(result).toEqual({ stdout: "doctor text\n", stderr: "offline\n", code: 1 });
    expect(injected.runDoctor).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.any(Object), fix: false }),
    );
  });

  it("renders a single JSON report and supports quiet mode", async () => {
    const injected = deps();
    const json = await runTopLevelDoctor(["--json"], injected);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, checks: [] });
    expect(json.stderr).toBe("");
    await expect(runTopLevelDoctor(["--quiet"], injected)).resolves.toEqual({
      stdout: "",
      stderr: "",
      code: 0,
    });
  });

  it("passes profile, config and fix to the existing implementations", async () => {
    const injected = deps();
    await runTopLevelDoctor(["--profile", "venue", "--config", "./tdmcp.json", "--fix"], injected);
    expect(injected.loadConfig).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        useFiles: true,
        profile: "venue",
        configPath: "./tdmcp.json",
        cwd: "/tmp/project",
      }),
    );
    expect(injected.runDoctor).toHaveBeenCalledWith(expect.objectContaining({ fix: true }));
  });

  it("returns help and typed argument/config failures", async () => {
    await expect(runTopLevelDoctor(["--help"], deps())).resolves.toMatchObject({ code: 0 });
    await expect(runTopLevelDoctor(["--unknown"], deps())).resolves.toMatchObject({ code: 2 });
    const injected = deps();
    injected.loadConfig = vi.fn(() => {
      throw new Error("profile missing");
    });
    await expect(runTopLevelDoctor(["--profile", "missing"], injected)).resolves.toEqual({
      stdout: "",
      stderr: "profile missing\n",
      code: 2,
    });
  });
});
