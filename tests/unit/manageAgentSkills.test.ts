import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeSkillRelativePath,
  buildCanonicalSkillCatalog,
  compareUtf8Bytewise,
  resolveBundledSkillRoot,
} from "../../src/skills/catalog.js";
import { manageAgentSkills, resolveSkillTargetRoot } from "../../src/skills/installer.js";
import { manifestPathFor } from "../../src/skills/manifest.js";
import {
  CURATED_AGENT_SKILLS,
  CURATED_SKILL_NAMES,
  type CuratedSkillName,
  type ManageAgentSkillsInput,
  type ManageAgentSkillsOptions,
  SKILL_CATALOG_LIMITS,
  SKILL_METADATA_MAX_BYTES,
  SkillManagerError,
} from "../../src/skills/types.js";
import {
  manageAgentSkillsImpl,
  manageAgentSkillsSchema,
} from "../../src/tools/layer3/manageAgentSkills.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(label = "tdmcp-skills-"): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function makeSource(
  root: string,
  content: Partial<Record<CuratedSkillName, string>> = {},
  selected: readonly CuratedSkillName[] = CURATED_SKILL_NAMES,
): string {
  const sourceRoot = join(root, "source");
  for (const name of selected) {
    const directory = join(sourceRoot, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "SKILL.md"),
      content[name] ?? `---\nname: ${name}\ndescription: test\n---\n\n# ${name}\n`,
    );
  }
  return sourceRoot;
}

function input(overrides: Partial<ManageAgentSkillsInput> = {}): ManageAgentSkillsInput {
  return {
    action: "status",
    host: "codex",
    scope: "project",
    dry_run: true,
    force_owned_drift: false,
    ...overrides,
  };
}

function options(root: string, sourceRoot: string): ManageAgentSkillsOptions {
  return {
    sourceRoot,
    projectRoot: join(root, "project"),
    homeDir: join(root, "home"),
    packageVersion: "9.9.9-test",
    bundleVersion: "1",
    now: () => new Date("2026-07-14T12:00:00.000Z"),
    randomId: () => "fixed",
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

describe("curated agent skill contract", () => {
  it("exports an exact, target-neutral descriptor for every allowlisted skill", () => {
    expect(CURATED_AGENT_SKILLS.map((skill) => skill.name)).toEqual([...CURATED_SKILL_NAMES]);
    for (const skill of CURATED_AGENT_SKILLS) {
      expect(skill.hosts).toEqual(["codex", "claude"]);
      expect(skill.files).toEqual(["SKILL.md"]);
      expect(skill.source_path).toBe(`skills/curated/${skill.name}`);
    }
  });

  it("resolves the checked-in source root and returns deterministic records", () => {
    const sourceRoot = resolveBundledSkillRoot();
    expect(existsSync(join(sourceRoot, "tdmcp-project-safety", "SKILL.md"))).toBe(true);
    const first = buildCanonicalSkillCatalog({ sourceRoot });
    const second = buildCanonicalSkillCatalog({ sourceRoot });
    expect(first).toEqual(second);
    expect(first.map((skill) => skill.name)).toEqual([...CURATED_SKILL_NAMES]);
    expect(first.every((skill) => skill.files.length === 1)).toBe(true);
  });

  it("uses bytewise UTF-8 order instead of the process locale", () => {
    expect(compareUtf8Bytewise("z", "é")).toBeLessThan(0);
    expect(["é", "a", "z"].sort(compareUtf8Bytewise)).toEqual(["a", "z", "é"]);
  });

  it.each([
    "../x",
    "x/../y",
    "C:/temp/x",
    "//server/share",
    "x\\y",
    "bad\u0000path",
  ])("rejects unsafe relative path %j", (unsafe) => {
    expect(() => assertSafeSkillRelativePath(unsafe)).toThrow(SkillManagerError);
  });

  it("rejects a symlink and any file outside the exact descriptor", () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root, {}, ["tdmcp-project-safety"]);
    const skillRoot = join(sourceRoot, "tdmcp-project-safety");
    writeFileSync(join(root, "outside.md"), "outside");
    rmSync(join(skillRoot, "SKILL.md"));
    symlinkSync(join(root, "outside.md"), join(skillRoot, "SKILL.md"));
    expect(() =>
      buildCanonicalSkillCatalog({
        sourceRoot,
        selectedSkills: ["tdmcp-project-safety"],
      }),
    ).toThrow(/symlink/u);

    rmSync(join(skillRoot, "SKILL.md"));
    writeFileSync(join(skillRoot, "SKILL.md"), "safe");
    writeFileSync(join(skillRoot, "EXTRA.md"), "not allowlisted");
    expect(() =>
      buildCanonicalSkillCatalog({
        sourceRoot,
        selectedSkills: ["tdmcp-project-safety"],
      }),
    ).toThrow(/exact file allowlist/u);
  });

  it("enforces file, file-count, and tree-size bounds", () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root, {}, ["tdmcp-project-safety"]);
    const skillRoot = join(sourceRoot, "tdmcp-project-safety");
    writeFileSync(join(skillRoot, "SKILL.md"), Buffer.alloc(SKILL_CATALOG_LIMITS.maxFileBytes + 1));
    expect(() =>
      buildCanonicalSkillCatalog({ sourceRoot, selectedSkills: ["tdmcp-project-safety"] }),
    ).toThrow(/exceeds/u);

    writeFileSync(join(skillRoot, "SKILL.md"), "safe");
    for (let index = 0; index < SKILL_CATALOG_LIMITS.maxFilesPerSkill; index += 1) {
      writeFileSync(join(skillRoot, `extra-${String(index).padStart(2, "0")}.md`), "x");
    }
    expect(() =>
      buildCanonicalSkillCatalog({ sourceRoot, selectedSkills: ["tdmcp-project-safety"] }),
    ).toThrow(/files/u);

    for (const file of readdirNames(skillRoot)) rmSync(join(skillRoot, file));
    writeFileSync(join(skillRoot, "SKILL.md"), Buffer.alloc(SKILL_CATALOG_LIMITS.maxFileBytes));
    for (let index = 0; index < 4; index += 1) {
      writeFileSync(
        join(skillRoot, `tree-${index}.md`),
        Buffer.alloc(SKILL_CATALOG_LIMITS.maxFileBytes),
      );
    }
    expect(() =>
      buildCanonicalSkillCatalog({ sourceRoot, selectedSkills: ["tdmcp-project-safety"] }),
    ).toThrow(/tree/u);
  });
});

function readdirNames(path: string): string[] {
  return readdirSync(path);
}

describe("target mapping and schema", () => {
  it("maps project and user roots without touching them", () => {
    const root = tempRoot();
    const project = join(root, "project");
    const home = join(root, "home");
    const codexHome = join(root, "custom-codex");
    expect(
      resolveSkillTargetRoot(
        { host: "codex", scope: "project", project_root: project },
        { homeDir: home },
      ),
    ).toBe(join(project, ".agents", "skills"));
    expect(
      resolveSkillTargetRoot(
        { host: "claude", scope: "project", project_root: project },
        { homeDir: home },
      ),
    ).toBe(join(project, ".claude", "skills"));
    expect(
      resolveSkillTargetRoot({ host: "codex", scope: "user" }, { homeDir: home, codexHome }),
    ).toBe(join(codexHome, "skills"));
    expect(resolveSkillTargetRoot({ host: "claude", scope: "user" }, { homeDir: home })).toBe(
      join(home, ".claude", "skills"),
    );
    expect(existsSync(project)).toBe(false);
  });

  it("defaults to dry run and rejects unknown names", () => {
    expect(
      manageAgentSkillsSchema.parse({ action: "install", host: "codex", scope: "user" }).dry_run,
    ).toBe(true);
    expect(() =>
      manageAgentSkillsSchema.parse({
        action: "install",
        host: "codex",
        scope: "user",
        skills: ["tdmcp-not-bundled"],
      }),
    ).toThrow();
  });

  it("requires absolute project roots and unique selected skills", () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root);
    expect(() =>
      manageAgentSkills(input({ project_root: "relative" }), options(root, sourceRoot)),
    ).toThrow(/absolute/u);
    expect(() =>
      manageAgentSkills(
        input({ skills: ["tdmcp-project-safety", "tdmcp-project-safety"] }),
        options(root, sourceRoot),
      ),
    ).toThrow(/more than once/u);
  });
});

describe("manageAgentSkills transaction", () => {
  it("plans by default with zero writes, then installs deterministically", () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root);
    const opts = options(root, sourceRoot);
    const targetRoot = resolveSkillTargetRoot(input(), opts);
    const dry = manageAgentSkills(input({ action: "install" }), opts);
    expect(dry.status).toBe("planned");
    expect(dry.applied).toEqual([]);
    expect(existsSync(targetRoot)).toBe(false);
    expect(dry.planned.map((item) => item.name)).toEqual([...CURATED_SKILL_NAMES]);

    const applied = manageAgentSkills(input({ action: "install", dry_run: false }), opts);
    expect(applied.status).toBe("applied");
    expect(applied.applied.every((item) => item.operation === "install")).toBe(true);
    expect(applied.skills.every((skill) => skill.state === "installed")).toBe(true);
    expect(existsSync(manifestPathFor(targetRoot))).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPathFor(targetRoot), "utf8")) as {
      skills: Array<{ name: string; files: Array<{ path: string }> }>;
    };
    expect(manifest.skills.map((skill) => skill.name)).toEqual([...CURATED_SKILL_NAMES]);
    expect(manifest.skills.every((skill) => skill.files[0]?.path === "SKILL.md")).toBe(true);
  });

  it("reports installed status and converges duplicate application to no_change", () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root);
    const opts = options(root, sourceRoot);
    manageAgentSkills(input({ action: "install", dry_run: false }), opts);
    const repeated = manageAgentSkills(input({ action: "install", dry_run: false }), opts);
    expect(repeated.status).toBe("no_change");
    expect(repeated.skills.every((skill) => skill.state === "installed")).toBe(true);
    const status = manageAgentSkills(input({ action: "status", dry_run: false }), opts);
    expect(status.dry_run).toBe(true);
    expect(status.status).toBe("no_change");
  });

  it("updates a selected owned skill and preserves the other records", () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root);
    const opts = options(root, sourceRoot);
    manageAgentSkills(input({ action: "install", dry_run: false }), opts);
    writeFileSync(join(sourceRoot, "tdmcp-project-safety", "SKILL.md"), "version two");
    const updated = manageAgentSkills(
      input({
        action: "update",
        dry_run: false,
        skills: ["tdmcp-project-safety"],
      }),
      opts,
    );
    expect(updated.status).toBe("applied");
    expect(updated.applied[0]?.operation).toBe("update");
    expect(
      readFileSync(join(updated.target_root, "tdmcp-project-safety", "SKILL.md"), "utf8"),
    ).toBe("version two");
    const manifest = JSON.parse(readFileSync(updated.manifest_path, "utf8")) as {
      skills: unknown[];
    };
    expect(manifest.skills).toHaveLength(3);
  });

  it("uninstalls only exact manifest ownership and preserves unrelated directories", () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root);
    const opts = options(root, sourceRoot);
    const installed = manageAgentSkills(input({ action: "install", dry_run: false }), opts);
    mkdirSync(join(installed.target_root, "tdmcp-user-skill"), { recursive: true });
    writeFileSync(join(installed.target_root, "tdmcp-user-skill", "SKILL.md"), "mine");
    mkdirSync(join(installed.target_root, "other-skill"));
    const removed = manageAgentSkills(input({ action: "uninstall", dry_run: false }), opts);
    expect(removed.status).toBe("applied");
    expect(existsSync(join(installed.target_root, "tdmcp-user-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(installed.target_root, "other-skill"))).toBe(true);
    expect(existsSync(join(installed.target_root, "tdmcp-project-safety"))).toBe(false);
    expect(removed.skills.every((skill) => skill.state === "not_installed")).toBe(true);
  });

  it("fails closed on an unowned same-name destination", () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root);
    const opts = options(root, sourceRoot);
    const targetRoot = resolveSkillTargetRoot(input(), opts);
    mkdirSync(join(targetRoot, "tdmcp-project-safety"), { recursive: true });
    writeFileSync(join(targetRoot, "tdmcp-project-safety", "SKILL.md"), "user owned");
    const result = manageAgentSkills(
      input({ action: "install", dry_run: false, skills: ["tdmcp-project-safety"] }),
      opts,
    );
    expect(result.status).toBe("conflict");
    expect(result.applied).toEqual([]);
    expect(readFileSync(join(targetRoot, "tdmcp-project-safety", "SKILL.md"), "utf8")).toBe(
      "user owned",
    );
    expect(existsSync(manifestPathFor(targetRoot))).toBe(false);
  });

  it("blocks owned drift unless force_owned_drift is explicit", () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root, { "tdmcp-project-safety": "source" });
    const opts = options(root, sourceRoot);
    const installArgs = input({
      action: "install",
      dry_run: false,
      skills: ["tdmcp-project-safety"],
    });
    const installed = manageAgentSkills(installArgs, opts);
    const installedFile = join(installed.target_root, "tdmcp-project-safety", "SKILL.md");
    writeFileSync(installedFile, "local edit");
    const blocked = manageAgentSkills(input({ ...installArgs, action: "update" }), opts);
    expect(blocked.status).toBe("conflict");
    expect(readFileSync(installedFile, "utf8")).toBe("local edit");

    const forced = manageAgentSkills(
      input({ ...installArgs, action: "update", force_owned_drift: true }),
      opts,
    );
    expect(forced.status).toBe("applied");
    expect(readFileSync(installedFile, "utf8")).toBe("source");
  });

  it("restores content and manifest after a partial update failure", () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root, { "tdmcp-project-safety": "version one" });
    const opts = options(root, sourceRoot);
    const selected = input({
      action: "install",
      dry_run: false,
      skills: ["tdmcp-project-safety"],
    });
    const installed = manageAgentSkills(selected, opts);
    const manifestBefore = readFileSync(installed.manifest_path, "utf8");
    writeFileSync(join(sourceRoot, "tdmcp-project-safety", "SKILL.md"), "version two");
    const failed = manageAgentSkills(input({ ...selected, action: "update" }), {
      ...opts,
      onTransactionStep(step) {
        if (step === "after_swap") throw new Error("injected failure");
      },
    });
    expect(failed.status).toBe("failed");
    expect(readFileSync(installed.manifest_path, "utf8")).toBe(manifestBefore);
    expect(
      readFileSync(join(installed.target_root, "tdmcp-project-safety", "SKILL.md"), "utf8"),
    ).toBe("version one");
    expect(
      readdirNames(installed.target_root).some((name) => name.startsWith(".tdmcp-skills-txn-")),
    ).toBe(false);
  });

  it("refuses a corrupt or wrong-host manifest before writing", () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root);
    const opts = options(root, sourceRoot);
    const targetRoot = resolveSkillTargetRoot(input(), opts);
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(manifestPathFor(targetRoot), "not-json");
    expect(() => manageAgentSkills(input(), opts)).toThrow(/not valid JSON/u);

    rmSync(manifestPathFor(targetRoot));
    const installed = manageAgentSkills(input({ action: "install", dry_run: false }), opts);
    const manifest = JSON.parse(readFileSync(installed.manifest_path, "utf8")) as Record<
      string,
      unknown
    >;
    manifest.host = "claude";
    writeFileSync(installed.manifest_path, JSON.stringify(manifest));
    expect(() => manageAgentSkills(input(), opts)).toThrow(/host or scope/u);
  });

  it("rejects manifest symlinks and oversized manifests before reading content", () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root);
    const opts = options(root, sourceRoot);
    const targetRoot = resolveSkillTargetRoot(input(), opts);
    mkdirSync(targetRoot, { recursive: true });
    const outside = join(root, "outside-manifest.json");
    writeFileSync(outside, "{}");
    symlinkSync(outside, manifestPathFor(targetRoot));
    expect(() => manageAgentSkills(input(), opts)).toThrow(/regular file/u);

    rmSync(manifestPathFor(targetRoot));
    writeFileSync(manifestPathFor(targetRoot), Buffer.alloc(SKILL_METADATA_MAX_BYTES + 1));
    expect(() => manageAgentSkills(input(), opts)).toThrow(/too large/u);
  });

  it("rejects a symlinked target root without listing or writing through it", () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root);
    const opts = options(root, sourceRoot);
    const targetRoot = resolveSkillTargetRoot(input(), opts);
    const outside = join(root, "outside-target");
    mkdirSync(outside);
    mkdirSync(dirname(targetRoot), { recursive: true });
    symlinkSync(outside, targetRoot);
    expect(() => manageAgentSkills(input({ action: "install", dry_run: false }), opts)).toThrow(
      /not a regular directory/u,
    );
    expect(readdirNames(outside)).toEqual([]);
  });
});

describe("manage_agent_skills MCP tool", () => {
  const ctx = { logger: silentLogger } as unknown as ToolContext;

  it("returns a machine-readable dry-run plan without using the bridge", async () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root);
    const result = await manageAgentSkillsImpl(
      ctx,
      manageAgentSkillsSchema.parse({
        action: "install",
        host: "codex",
        scope: "project",
        project_root: join(root, "project"),
        skills: ["tdmcp-project-safety"],
      }),
      options(root, sourceRoot),
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: "planned", dry_run: true });
    expect(textOf(result)).toContain("dry run made no writes");
  });

  it("turns invalid filesystem input into a typed MCP error instead of throwing", async () => {
    const root = tempRoot();
    const sourceRoot = makeSource(root);
    const result = await manageAgentSkillsImpl(
      ctx,
      manageAgentSkillsSchema.parse({
        action: "status",
        host: "codex",
        scope: "project",
        project_root: "relative",
      }),
      options(root, sourceRoot),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PROJECT_ROOT_NOT_ABSOLUTE");
  });
});
