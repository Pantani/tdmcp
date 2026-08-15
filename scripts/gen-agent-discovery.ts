import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCanonicalSkillCatalog } from "../src/skills/catalog.js";
import { parseNote } from "../src/vault/frontmatter.js";

export const AGENT_SKILLS_DISCOVERY_SCHEMA =
  "https://schemas.agentskills.io/discovery/0.2.0/schema.json" as const;

export interface AgentSkillDiscoveryEntry {
  name: string;
  type: "skill-md";
  description: string;
  url: string;
  digest: `sha256:${string}`;
}

export interface GenerateAgentDiscoveryOptions {
  repoRoot?: string;
  outputRoot?: string;
}

export interface GenerateAgentDiscoveryResult {
  indexPath: string;
  skillCount: number;
  skills: AgentSkillDiscoveryEntry[];
}

function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function skillMetadata(raw: string, expectedName: string): { name: string; description: string } {
  const { data } = parseNote(raw);
  const name = data.name;
  const description = data.description;
  if (name !== expectedName) {
    throw new Error(`Skill frontmatter name must match ${expectedName}.`);
  }
  if (
    typeof description !== "string" ||
    description.trim().length === 0 ||
    description.length > 1_024
  ) {
    throw new Error(`Skill ${expectedName} must have a 1..1024 character description.`);
  }
  return { name, description: description.trim() };
}

export function generateAgentSkillsDiscovery(
  options: GenerateAgentDiscoveryOptions = {},
): GenerateAgentDiscoveryResult {
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot());
  const outputRoot = resolve(options.outputRoot ?? join(repoRoot, "docs/public"));
  const discoveryRoot = join(outputRoot, ".well-known", "agent-skills");
  rmSync(discoveryRoot, { force: true, recursive: true });
  const catalog = buildCanonicalSkillCatalog({
    sourceRoot: join(repoRoot, "skills", "curated"),
  });
  const skills = catalog.map((record): AgentSkillDiscoveryEntry => {
    const source = join(repoRoot, record.source_path, "SKILL.md");
    const bytes = readFileSync(source);
    const metadata = skillMetadata(bytes.toString("utf8"), record.name);
    const digest = sha256(bytes);
    const catalogDigest = record.files.find((file) => file.path === "SKILL.md")?.sha256;
    if (digest !== catalogDigest) {
      throw new Error(`Skill ${record.name} changed while its discovery index was generated.`);
    }
    const destination = join(discoveryRoot, record.name, "SKILL.md");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
    return {
      name: metadata.name,
      type: "skill-md",
      description: metadata.description,
      url: `${record.name}/SKILL.md`,
      digest: `sha256:${digest}`,
    };
  });
  const indexPath = join(discoveryRoot, "index.json");
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(
    indexPath,
    `${JSON.stringify({ $schema: AGENT_SKILLS_DISCOVERY_SCHEMA, skills }, null, 2)}\n`,
  );
  return { indexPath, skillCount: skills.length, skills };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  const result = generateAgentSkillsDiscovery();
  process.stdout.write(
    `Generated Agent Skills discovery index with ${result.skillCount} skills at ${result.indexPath}\n`,
  );
}
