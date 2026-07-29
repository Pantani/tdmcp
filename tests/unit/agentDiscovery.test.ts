import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_SKILLS_DISCOVERY_SCHEMA,
  generateAgentSkillsDiscovery,
} from "../../scripts/gen-agent-discovery.js";
import { CURATED_SKILL_NAMES } from "../../src/skills/types.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("Agent Skills discovery generator", () => {
  it("publishes the curated SKILL.md bytes with verifiable v0.2.0 digests", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const outputRoot = mkdtempSync(join(tmpdir(), "tdmcp-agent-discovery-"));
    temporary.push(outputRoot);
    const staleSkill = join(outputRoot, ".well-known", "agent-skills", "removed-skill", "SKILL.md");
    mkdirSync(dirname(staleSkill), { recursive: true });
    writeFileSync(staleSkill, "stale");

    const result = generateAgentSkillsDiscovery({ repoRoot, outputRoot });
    const index = JSON.parse(readFileSync(result.indexPath, "utf8")) as {
      $schema: string;
      skills: Array<{
        name: string;
        type: string;
        description: string;
        url: string;
        digest: string;
      }>;
    };

    expect(index.$schema).toBe(AGENT_SKILLS_DISCOVERY_SCHEMA);
    expect(index.skills.map((skill) => skill.name)).toEqual([...CURATED_SKILL_NAMES]);
    expect(result.skillCount).toBe(CURATED_SKILL_NAMES.length);
    expect(existsSync(staleSkill)).toBe(false);

    for (const skill of index.skills) {
      expect(skill).toMatchObject({
        type: "skill-md",
        url: `${skill.name}/SKILL.md`,
      });
      expect(skill.description.length).toBeGreaterThan(0);
      const published = readFileSync(join(dirname(result.indexPath), skill.url));
      const source = readFileSync(join(repoRoot, "skills", "curated", skill.name, "SKILL.md"));
      expect(published).toEqual(source);
      expect(skill.digest).toBe(`sha256:${createHash("sha256").update(published).digest("hex")}`);
    }
  });
});
