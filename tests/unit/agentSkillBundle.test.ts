import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseAgentSkillBundleArgs,
  runBuildAgentSkillsCli,
} from "../../scripts/build-agent-skills.js";
import {
  type BuildAgentSkillBundleResult,
  buildAgentSkillBundle,
} from "../../src/skills/bundle.js";
import { crc32 } from "../../src/skills/deterministicZip.js";
import { CURATED_AGENT_SKILLS, CURATED_SKILL_NAMES } from "../../src/skills/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function fixtureRepo(): string {
  const created = mkdtempSync(join(tmpdir(), "tdmcp-agent-bundle-"));
  roots.push(created);
  const root = realpathSync(created);
  writeFileSync(join(root, "package.json"), '{"name":"fixture","version":"9.8.7"}\n');
  for (const descriptor of CURATED_AGENT_SKILLS) {
    const skillRoot = join(root, descriptor.source_path);
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      `---\nname: ${descriptor.name}\ndescription: fixture\n---\n\n# ${descriptor.name}\n`,
    );
  }
  return root;
}

function build(
  root: string,
  overrides: Partial<Parameters<typeof buildAgentSkillBundle>[0]> = {},
): BuildAgentSkillBundleResult {
  return buildAgentSkillBundle({
    repoRoot: root,
    outputDir: join(root, "out", "agent-skills"),
    archiveMode: "skill",
    bundleVersion: "bundle-1",
    overwrite: false,
    verifyReproducible: false,
    ...overrides,
  });
}

interface ParsedZipEntry {
  path: string;
  data: Buffer;
  crc: number;
  method: number;
  flags: number;
  time: number;
  date: number;
}

function parseLocalZipEntries(bytes: Buffer): ParsedZipEntry[] {
  const entries: ParsedZipEntry[] = [];
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const time = bytes.readUInt16LE(offset + 10);
    const date = bytes.readUInt16LE(offset + 12);
    const crc = bytes.readUInt32LE(offset + 14);
    const size = bytes.readUInt32LE(offset + 18);
    const nameSize = bytes.readUInt16LE(offset + 26);
    const extraSize = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameSize + extraSize;
    entries.push({
      path: bytes.subarray(nameStart, nameStart + nameSize).toString("utf8"),
      data: bytes.subarray(dataStart, dataStart + size),
      crc,
      method,
      flags,
      time,
      date,
    });
    offset = dataStart + size;
  }
  expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
  return entries;
}

function firstCentralZipRecord(bytes: Buffer): {
  path: string;
  versionMadeBy: number;
  method: number;
  flags: number;
  extraSize: number;
  commentSize: number;
  mode: number;
} {
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameSize = bytes.readUInt16LE(offset + 26);
    const extraSize = bytes.readUInt16LE(offset + 28);
    offset += 30 + nameSize + extraSize + size;
  }
  expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
  const nameSize = bytes.readUInt16LE(offset + 28);
  return {
    path: bytes.subarray(offset + 46, offset + 46 + nameSize).toString("utf8"),
    versionMadeBy: bytes.readUInt16LE(offset + 4),
    flags: bytes.readUInt16LE(offset + 8),
    method: bytes.readUInt16LE(offset + 10),
    extraSize: bytes.readUInt16LE(offset + 30),
    commentSize: bytes.readUInt16LE(offset + 32),
    mode: bytes.readUInt32LE(offset + 38) >>> 16,
  };
}

function fileHashes(root: string, paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(paths.map((path) => [path, sha256(readFileSync(join(root, path)))]));
}

describe("buildAgentSkillBundle", () => {
  it("builds the exact host payload, canonical manifest, checksums, and STORE archives", () => {
    const root = fixtureRepo();
    const result = build(root);
    expect(result.status).toBe("built");
    expect(result.package_version).toBe("9.8.7");
    expect(result.hosts).toEqual([
      { host: "claude", skill_count: 3 },
      { host: "codex", skill_count: 3 },
    ]);
    expect(result.archive_count).toBe(6);
    expect(result.side_effects).toEqual({
      installed: false,
      published: false,
      attached: false,
      released: false,
    });

    const manifestRaw = readFileSync(result.manifest_path, "utf8");
    const manifest = JSON.parse(manifestRaw) as {
      kind: string;
      source: { package_version: string; bundle_version: string };
      hosts: Array<{ host: string; skills: Array<{ name: string; files: unknown[] }> }>;
      archives: Array<{ path: string; sha256: string; size: number; format: string }>;
    };
    expect(manifest.kind).toBe("tdmcp-agent-skill-bundle");
    expect(manifest.source).toEqual({
      kind: "bundled",
      package_version: "9.8.7",
      bundle_version: "bundle-1",
    });
    expect(manifestRaw).not.toMatch(/generated|timestamp|username|hostname|installed_at/u);
    expect(manifest.hosts.map((host) => host.host)).toEqual(["claude", "codex"]);
    expect(manifest.hosts[0]?.skills.map((skill) => skill.name)).toEqual([...CURATED_SKILL_NAMES]);
    expect(sha256(manifestRaw)).toBe(result.manifest_sha256);

    for (const host of ["claude", "codex"] as const) {
      for (const name of CURATED_SKILL_NAMES) {
        const payload = join(
          result.output_dir,
          "hosts",
          host,
          "skills",
          "curated",
          name,
          "SKILL.md",
        );
        expect(readFileSync(payload)).toEqual(
          readFileSync(join(root, "skills/curated", name, "SKILL.md")),
        );
        expect(statSync(payload).mode & 0o777).toBe(0o644);
        const archiveRecord = manifest.archives.find(
          (entry) => entry.path === `archives/${host}/${name}.skill`,
        );
        expect(archiveRecord?.format).toBe("skill-zip-store-v1");
        const archive = readFileSync(join(result.output_dir, archiveRecord?.path ?? "missing"));
        expect(sha256(archive)).toBe(archiveRecord?.sha256);
        expect(archive.byteLength).toBe(archiveRecord?.size);
        const entries = parseLocalZipEntries(archive);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          path: `${name}/SKILL.md`,
          method: 0,
          flags: 0x0800,
          time: 0,
          date: 0x0021,
        });
        expect(entries[0]?.crc).toBe(crc32(entries[0]?.data ?? Buffer.alloc(0)));
        expect(entries[0]?.data).toEqual(readFileSync(payload));
        expect(firstCentralZipRecord(archive)).toEqual({
          path: `${name}/SKILL.md`,
          versionMadeBy: 0x0314,
          method: 0,
          flags: 0x0800,
          extraSize: 0,
          commentSize: 0,
          mode: 0o100644,
        });
      }
    }

    const checksumRaw = readFileSync(result.checksums_path, "utf8");
    expect(sha256(checksumRaw)).toBe(result.checksums_sha256);
    const checksumPaths = checksumRaw
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(66));
    expect(checksumPaths).toContain("bundle.manifest.json");
    expect(checksumPaths).not.toContain("SHA256SUMS");
    for (const line of checksumRaw.trimEnd().split("\n")) {
      const digest = line.slice(0, 64);
      const path = line.slice(66);
      expect(sha256(readFileSync(join(result.output_dir, path)))).toBe(digest);
    }
  });

  it("verifies byte-for-byte reproducibility independent of mtimes and executable bits", () => {
    const root = fixtureRepo();
    const source = join(root, "skills/curated/tdmcp-project-safety/SKILL.md");
    chmodSync(source, 0o755);
    utimesSync(source, new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
    const first = build(root, { verifyReproducible: true });
    const compared = [
      "bundle.manifest.json",
      "SHA256SUMS",
      "archives/claude/tdmcp-project-safety.skill",
      "archives/codex/tdmcp-project-safety.skill",
    ];
    const before = fileHashes(first.output_dir, compared);
    chmodSync(source, 0o600);
    utimesSync(source, new Date("2040-01-01T00:00:00Z"), new Date("2040-01-01T00:00:00Z"));
    const second = build(root, {
      outputDir: join(root, "out", "second"),
      verifyReproducible: true,
    });
    expect(first.status).toBe("verified");
    expect(first.reproducible_verified).toBe(true);
    expect(fileHashes(second.output_dir, compared)).toEqual(before);
  });

  it("supports folder-only output and rejects output conflicts safely", () => {
    const root = fixtureRepo();
    const folderOnly = build(root, { archiveMode: "none" });
    const manifest = JSON.parse(readFileSync(folderOnly.manifest_path, "utf8")) as {
      archives: unknown[];
    };
    expect(manifest.archives).toEqual([]);
    expect(folderOnly.archive_count).toBe(0);
    expect(existsSync(join(folderOnly.output_dir, "archives"))).toBe(false);
    expect(() => build(root)).toThrow(/already exists/u);

    const unmarked = join(root, "unmarked");
    mkdirSync(unmarked);
    writeFileSync(join(unmarked, "keep.txt"), "keep");
    expect(() => build(root, { outputDir: unmarked, overwrite: true })).toThrow(/unmarked/u);
    expect(readFileSync(join(unmarked, "keep.txt"), "utf8")).toBe("keep");

    expect(() => build(root, { outputDir: root })).toThrow(/protected/u);
    expect(() => build(root, { outputDir: join(root, "skills/curated") })).toThrow(/protected/u);
  });

  it("overwrites only a marked bundle and rejects a symlink destination", () => {
    const root = fixtureRepo();
    const first = build(root);
    writeFileSync(join(first.output_dir, "obsolete.txt"), "old");
    const replaced = build(root, { overwrite: true, bundleVersion: "bundle-2" });
    expect(replaced.bundle_version).toBe("bundle-2");
    expect(existsSync(join(replaced.output_dir, "obsolete.txt"))).toBe(false);

    const markerBeforeFailure = readFileSync(replaced.manifest_path);
    writeFileSync(join(replaced.output_dir, "preserve.txt"), "preserve");
    writeFileSync(join(root, "skills/curated/tdmcp-project-safety/UNDECLARED.md"), "blocked");
    expect(() => build(root, { overwrite: true, bundleVersion: "bundle-3" })).toThrow(/allowlist/u);
    expect(readFileSync(replaced.manifest_path)).toEqual(markerBeforeFailure);
    expect(readFileSync(join(replaced.output_dir, "preserve.txt"), "utf8")).toBe("preserve");

    const outside = join(root, "outside");
    mkdirSync(outside);
    const linked = join(root, "linked-output");
    symlinkSync(outside, linked);
    expect(() => build(root, { outputDir: linked, overwrite: true })).toThrow(
      /symlink|regular directory/u,
    );
    expect(existsSync(join(outside, "bundle.manifest.json"))).toBe(false);
  });

  it.each([
    "",
    " contains space",
    "../bad",
    "bad/value",
    "x".repeat(65),
  ])("rejects invalid bundle version %j without creating output", (bundleVersion) => {
    const root = fixtureRepo();
    const output = join(root, "out", "agent-skills");
    expect(() => build(root, { bundleVersion })).toThrow(/version/u);
    expect(existsSync(output)).toBe(false);
  });
});

describe("build-agent-skills CLI", () => {
  it("accepts pnpm's conventional leading option separator", () => {
    expect(parseAgentSkillBundleArgs(["--", "--json"])).toMatchObject({ json: true });
  });
  it("parses only the bounded local packaging surface", () => {
    expect(
      parseAgentSkillBundleArgs([
        "--output",
        "out",
        "--archives",
        "none",
        "--bundle-version",
        "v1",
        "--overwrite",
        "--verify-reproducible",
        "--json",
      ]),
    ).toEqual({
      output: "out",
      archiveMode: "none",
      bundleVersion: "v1",
      overwrite: true,
      verifyReproducible: true,
      json: true,
      help: false,
    });
    expect(() => parseAgentSkillBundleArgs(["--publish"])).toThrow(/Unknown/u);
    expect(() => parseAgentSkillBundleArgs(["--source", "https://example.com"])).toThrow(
      /Unknown/u,
    );
  });

  it("prints help without reading repo state and emits JSON-only success", () => {
    const output: string[] = [];
    const errors: string[] = [];
    const streams = {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => errors.push(text),
    };
    expect(runBuildAgentSkillsCli(["--help"], { repoRoot: "/missing", streams })).toBe(0);
    expect(output.join("")).toContain("local-only");
    expect(errors).toEqual([]);

    output.length = 0;
    const root = fixtureRepo();
    expect(
      runBuildAgentSkillsCli(["--output", "built", "--json"], { repoRoot: root, streams }),
    ).toBe(0);
    const parsed = JSON.parse(output.join("")) as BuildAgentSkillBundleResult;
    expect(parsed.output_dir).toBe(join(root, "built"));
    expect(output).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("uses exit 2 for usage and exit 1 for build failures", () => {
    const output: string[] = [];
    const errors: string[] = [];
    const streams = {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => errors.push(text),
    };
    expect(runBuildAgentSkillsCli(["--archives", "zip"], { streams })).toBe(2);
    const root = fixtureRepo();
    expect(runBuildAgentSkillsCli(["--output", ".", "--json"], { repoRoot: root, streams })).toBe(
      1,
    );
    expect(output).toEqual([]);
    expect(errors.join("")).toContain("failed");
  });
});
