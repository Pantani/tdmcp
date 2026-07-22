import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentSkillBundle } from "../../src/skills/bundle.js";
import { manageAgentSkills } from "../../src/skills/installer.js";
import {
  CURATED_AGENT_SKILLS,
  CURATED_SKILL_NAMES,
  type ManageAgentSkillsInput,
  type ManageAgentSkillsOptions,
  type SkillHost,
} from "../../src/skills/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRepo(): string {
  const created = mkdtempSync(join(tmpdir(), "tdmcp-bundle-install-"));
  roots.push(created);
  const root = realpathSync(created);
  writeFileSync(join(root, "package.json"), '{"name":"fixture","version":"7.6.5"}\n');
  for (const descriptor of CURATED_AGENT_SKILLS) {
    const skillRoot = join(root, descriptor.source_path);
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      `---\nname: ${descriptor.name}\ndescription: install smoke\n---\n\n# ${descriptor.name}\n`,
    );
  }
  return root;
}

function input(
  host: SkillHost,
  projectRoot: string,
  action: ManageAgentSkillsInput["action"],
): ManageAgentSkillsInput {
  return {
    action,
    host,
    scope: "project",
    project_root: projectRoot,
    dry_run: true,
    force_owned_drift: false,
  };
}

function options(sourceRoot: string, root: string): ManageAgentSkillsOptions {
  return {
    sourceRoot,
    homeDir: join(root, "home"),
    packageVersion: "7.6.5",
    bundleVersion: "smoke-1",
    now: () => new Date("2026-07-14T18:00:00.000Z"),
    randomId: () => "bundle-smoke",
  };
}

function parseStoredArchive(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    expect(bytes.readUInt16LE(offset + 8)).toBe(0);
    const size = bytes.readUInt32LE(offset + 18);
    const nameSize = bytes.readUInt16LE(offset + 26);
    const extraSize = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameSize + extraSize;
    const path = bytes.subarray(nameStart, nameStart + nameSize).toString("utf8");
    expect(path.startsWith("/") || path.includes("../") || path.includes("\\")).toBe(false);
    entries.set(path, bytes.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
  return entries;
}

describe("agent skill bundle -> real installer smoke", () => {
  it.each([
    "codex",
    "claude",
  ] as const)("installs, reports, and uninstalls the %s host payload without touching unrelated skills", (host) => {
    const root = fixtureRepo();
    const bundle = buildAgentSkillBundle({
      repoRoot: root,
      outputDir: join(root, "bundle"),
      archiveMode: "skill",
      bundleVersion: "smoke-1",
      overwrite: false,
      verifyReproducible: true,
    });
    const manifest = JSON.parse(readFileSync(bundle.manifest_path, "utf8")) as {
      hosts: Array<{
        host: SkillHost;
        skills: Array<{
          name: string;
          tree_sha256: string;
          source_path: string;
          files: Array<{ path: string; sha256: string; size: number }>;
        }>;
      }>;
      archives: Array<{ host: SkillHost; name: string; path: string }>;
    };
    const sourceRoot = join(bundle.output_dir, "hosts", host, "skills", "curated");
    const projectRoot = join(root, `${host}-project`);
    const installOptions = options(sourceRoot, root);

    for (const archive of manifest.archives.filter((record) => record.host === host)) {
      const archived = parseStoredArchive(readFileSync(join(bundle.output_dir, archive.path)));
      expect([...archived.keys()]).toEqual([`${archive.name}/SKILL.md`]);
      expect(archived.get(`${archive.name}/SKILL.md`)).toEqual(
        readFileSync(join(sourceRoot, archive.name, "SKILL.md")),
      );
    }

    const dry = manageAgentSkills(input(host, projectRoot, "install"), installOptions);
    expect(dry.status).toBe("planned");
    expect(dry.applied).toEqual([]);
    expect(existsSync(dry.target_root)).toBe(false);

    const installed = manageAgentSkills(
      { ...input(host, projectRoot, "install"), dry_run: false },
      installOptions,
    );
    expect(installed.status).toBe("applied");
    expect(installed.skills.every((skill) => skill.state === "installed")).toBe(true);
    const installedManifest = JSON.parse(readFileSync(installed.manifest_path, "utf8")) as {
      host: SkillHost;
      target_root: string;
      manifest_path: string;
      installed_at: string;
      updated_at: string;
      source: { package_version: string; bundle_version: string };
      skills: Array<{
        name: string;
        tree_sha256: string;
        source_path: string;
        files: Array<{ path: string; sha256: string; size: number }>;
      }>;
    };
    const bundledHost = manifest.hosts.find((record) => record.host === host);
    expect(installedManifest.host).toBe(host);
    expect(installedManifest.source).toEqual({
      kind: "bundled",
      package_version: "7.6.5",
      bundle_version: "smoke-1",
    });
    expect(installedManifest.skills).toEqual(bundledHost?.skills);
    expect(installedManifest.skills.map((skill) => skill.name)).toEqual([...CURATED_SKILL_NAMES]);
    expect(installedManifest.target_root).toBe(installed.target_root);
    expect(installedManifest.manifest_path).toBe(installed.manifest_path);
    expect(installedManifest.installed_at).toBe("2026-07-14T18:00:00.000Z");

    const status = manageAgentSkills(input(host, projectRoot, "status"), installOptions);
    expect(status.status).toBe("no_change");
    expect(status.skills.every((skill) => skill.state === "installed")).toBe(true);

    const unrelated = join(installed.target_root, "user-authored-skill");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "SKILL.md"), "do not remove");
    const removed = manageAgentSkills(
      { ...input(host, projectRoot, "uninstall"), dry_run: false },
      installOptions,
    );
    expect(removed.status).toBe("applied");
    expect(readFileSync(join(unrelated, "SKILL.md"), "utf8")).toBe("do not remove");
    for (const name of CURATED_SKILL_NAMES) {
      expect(existsSync(join(installed.target_root, name))).toBe(false);
    }
  });

  it("preserves unowned collisions and blocks drift unless force is explicit", () => {
    const root = fixtureRepo();
    const bundle = buildAgentSkillBundle({
      repoRoot: root,
      outputDir: join(root, "bundle"),
      archiveMode: "none",
      bundleVersion: "smoke-1",
      overwrite: false,
      verifyReproducible: false,
    });
    const sourceRoot = join(bundle.output_dir, "hosts", "codex", "skills", "curated");
    const projectRoot = join(root, "project");
    const installOptions = options(sourceRoot, root);
    const selected = {
      ...input("codex", projectRoot, "install"),
      skills: ["tdmcp-project-safety"],
      dry_run: false,
    };
    const targetRoot = join(projectRoot, ".agents", "skills");
    mkdirSync(join(targetRoot, "tdmcp-project-safety"), { recursive: true });
    writeFileSync(join(targetRoot, "tdmcp-project-safety", "SKILL.md"), "user-owned");
    const conflict = manageAgentSkills(selected, installOptions);
    expect(conflict.status).toBe("conflict");
    expect(readFileSync(join(targetRoot, "tdmcp-project-safety", "SKILL.md"), "utf8")).toBe(
      "user-owned",
    );

    rmSync(targetRoot, { recursive: true });
    const installed = manageAgentSkills(selected, installOptions);
    expect(installed.status).toBe("applied");
    const installedPath = join(targetRoot, "tdmcp-project-safety", "SKILL.md");
    writeFileSync(installedPath, "local drift");
    const blocked = manageAgentSkills({ ...selected, action: "update" }, installOptions);
    expect(blocked.status).toBe("conflict");
    expect(readFileSync(installedPath, "utf8")).toBe("local drift");
    const forced = manageAgentSkills(
      { ...selected, action: "update", force_owned_drift: true },
      installOptions,
    );
    expect(forced.status).toBe("applied");
    expect(readFileSync(installedPath)).toEqual(
      readFileSync(join(sourceRoot, "tdmcp-project-safety", "SKILL.md")),
    );
  });
});
