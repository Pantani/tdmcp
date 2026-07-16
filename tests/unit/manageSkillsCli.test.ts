import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runManageSkillsCli } from "../../src/cli/manageSkills.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "tdmcp-skills-cli-"));
  roots.push(value);
  return value;
}

describe("tdmcp skills CLI", () => {
  it("requires explicit host and scope", () => {
    expect(runManageSkillsCli(["status"]).code).toBe(2);
    expect(runManageSkillsCli(["status", "--host", "codex"]).code).toBe(2);
  });

  it("plans project installation by default without writing", () => {
    const cwd = root();
    const result = runManageSkillsCli(
      ["install", "--host", "codex", "--scope", "project", "--json"],
      { cwd },
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout ?? "{}") as Record<string, unknown>;
    expect(payload.status).toBe("planned");
    expect(payload.dry_run).toBe(true);
    expect(() => readFileSync(join(cwd, ".agents/skills/.tdmcp-skills.json"))).toThrow();
  });

  it("applies and confirms manifest-owned skills only with --apply", () => {
    const cwd = root();
    const result = runManageSkillsCli(
      [
        "install",
        "--host",
        "claude",
        "--scope",
        "project",
        "--skill",
        "tdmcp-project-safety",
        "--apply",
        "--json",
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout ?? "{}") as Record<string, unknown>;
    expect(payload.status).toBe("applied");
    expect(payload.dry_run).toBe(false);
    expect(
      readFileSync(join(cwd, ".claude/skills/tdmcp-project-safety/SKILL.md"), "utf8"),
    ).toContain("tdmcp-project-safety");
  });

  it("rejects unknown skills and extra positionals", () => {
    const cwd = root();
    expect(
      runManageSkillsCli(
        ["install", "--host", "codex", "--scope", "project", "--skill", "untrusted-remote-skill"],
        { cwd },
      ).code,
    ).toBe(1);
    expect(
      runManageSkillsCli(["status", "extra", "--host", "codex", "--scope", "project"], {
        cwd,
      }).code,
    ).toBe(2);
  });
});
