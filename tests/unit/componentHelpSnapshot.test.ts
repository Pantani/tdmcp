import { createHash } from "node:crypto";
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
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TdDocsLookupRequest, TdDocsOutput } from "../../src/knowledge/tdDocsTypes.js";
import {
  type ArtifactRoundtripReport,
  attachComponentHelpSnapshot,
  type ComponentHelpDocsResolver,
  componentHelpSnapshotSchema,
  normalizeHelpIdentity,
  safeHelpIdentitySchema,
} from "../../src/tools/library/componentHelpSnapshot.js";

const BUILD = "2025.32820";
const SHA = "2c2ca7068438b9e7376f768e1c5807767bdf50e887860919a3fb8d4f6b049e3f";
const OTHER_SHA = "3c2ca7068438b9e7376f768e1c5807767bdf50e887860919a3fb8d4f6b049e3f";
const roots: string[] = [];

interface PackageFixture {
  root: string;
  manifest: string;
  helpRoot: string;
}

function packageFixture(existingSnapshot = false): PackageFixture {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-component-help-"));
  roots.push(root);
  const manifest = join(root, "tdmcp-component.json");
  const helpRoot = join(root, "docs", "td-help");
  if (existingSnapshot) {
    mkdirSync(helpRoot, { recursive: true });
    writeFileSync(join(helpRoot, "old.md"), "old snapshot\n", "utf8");
  }
  writeFileSync(
    manifest,
    `${JSON.stringify(
      {
        name: "fixture",
        docs: existingSnapshot ? ["z.md", "docs/td-help/old.md", "a.md"] : ["z.md", "a.md"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { root, manifest, helpRoot };
}

function roundtrip(
  operatorTypes: Record<string, number> = { NoiseTOP: 1 },
  overrides: Partial<ArtifactRoundtripReport> = {},
): ArtifactRoundtripReport {
  return {
    artifact_sha256: SHA,
    td_build: BUILD,
    operator_type_counts: operatorTypes,
    contract_verdict: "PASS",
    ...overrides,
  };
}

function helpSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    python_apis: [],
    max_operator_types: 32,
    max_sections_per_page: 2,
    max_chars_per_section: 3_000,
    max_total_bytes: 262_144,
    quarantine_port: 9_981,
    ...overrides,
  };
}

function foundDocs(
  request: TdDocsLookupRequest,
  options: {
    build?: string;
    content?: string;
    source?: "installed-offline" | "embedded" | "web";
  } = {},
): TdDocsOutput {
  const kind = request.kind === "python" ? "python" : "operator";
  const section = request.section ?? "Summary";
  const content = options.content ?? `${section} help for ${request.query}`;
  const build = options.build ?? BUILD;
  const source = options.source ?? "installed-offline";
  return {
    status: "found",
    query: request.query,
    kind_requested: request.kind,
    page: { id: request.query, title: request.query, kind, matched_by: "exact" },
    content,
    content_chars: content.length,
    content_truncated: false,
    sections_available: [{ id: section, title: section, level: 2 }],
    sections_truncated: false,
    selected_section: { id: section, title: section, level: 2 },
    candidates: [],
    provenance: {
      source,
      installed_corpus_build: build,
      running_td_build: BUILD,
      build_relation: build === BUILD ? "match" : "mismatch",
      cache: "miss",
      sources_attempted: [source],
    },
    warnings: [],
  };
}

function resolver(
  handler: (request: TdDocsLookupRequest) => TdDocsOutput = (request) => foundDocs(request),
): ComponentHelpDocsResolver & ReturnType<typeof vi.fn> {
  return vi.fn(async (request: TdDocsLookupRequest) => handler(request));
}

function input(
  fixture: PackageFixture,
  report: ArtifactRoundtripReport,
  snapshot = helpSnapshot(),
) {
  return {
    package_dir: fixture.root,
    manifest_path: fixture.manifest,
    help_snapshot: snapshot,
    artifact_roundtrip_report: report,
  };
}

function dependencies(
  docsResolver: ComponentHelpDocsResolver,
  report: ArtifactRoundtripReport,
  extra: Record<string, unknown> = {},
) {
  return {
    resolveDocs: docsResolver,
    verifyArtifactRoundtrip: vi.fn(async () => report),
    ...extra,
  };
}

function readIndex(fixture: PackageFixture) {
  return JSON.parse(readFileSync(join(fixture.helpRoot, "index.json"), "utf8")) as {
    status: "PASS" | "UNVERIFIED";
    entries: Array<{
      identity: string;
      kind: "operator" | "python";
      status: "available" | "unavailable" | "truncated";
      reason?: string;
      path?: string;
      sha256?: string;
    }>;
    summary: { available: number; unavailable: number; truncated: number; total: number };
  };
}

function temporaryEntries(fixture: PackageFixture): string[] {
  const docs = join(fixture.root, "docs");
  return existsSync(docs) ? readdirSync(docs).filter((entry) => entry.startsWith(".td-help.")) : [];
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("componentHelpSnapshotSchema", () => {
  it("accepts explicit Python identities and rejects paths, code-like input, caps, and port 9980", () => {
    expect(safeHelpIdentitySchema.safeParse("COMP.loadTox").success).toBe(true);
    expect(safeHelpIdentitySchema.safeParse("/tmp/callbacks.py").success).toBe(false);
    expect(safeHelpIdentitySchema.safeParse("COMP.loadTox()").success).toBe(false);
    expect(componentHelpSnapshotSchema.safeParse(helpSnapshot()).success).toBe(true);
    expect(
      componentHelpSnapshotSchema.safeParse(helpSnapshot({ quarantine_port: 9_980 })).success,
    ).toBe(false);
    expect(
      componentHelpSnapshotSchema.safeParse(
        helpSnapshot({ python_apis: Array.from({ length: 33 }, (_, index) => `Api${index}`) }),
      ).success,
    ).toBe(false);
  });

  it("normalizes safe deterministic filenames and exposes collisions", () => {
    expect(normalizeHelpIdentity("COMP.loadTox")).toBe("comp-loadtox");
    expect(normalizeHelpIdentity("Foo.Bar")).toBe(normalizeHelpIdentity("Foo_Bar"));
  });
});

describe("attachComponentHelpSnapshot", () => {
  it("writes deterministic installed-build pages, README, index hashes, and sorted manifest refs", async () => {
    const fixture = packageFixture(true);
    const report = roundtrip({ ZetaTOP: 1, AlphaTOP: 2 });
    const docs = resolver();
    const snapshot = helpSnapshot({ python_apis: ["OP", "COMP.loadTox", "OP"] });
    const firstDependencies = dependencies(docs, report);

    const first = await attachComponentHelpSnapshot(
      input(fixture, report, snapshot),
      firstDependencies,
    );
    const firstIndexBytes = readFileSync(first.index_path);
    const firstHashes = first.files.map((file) => [file.path, file.sha256]);
    const second = await attachComponentHelpSnapshot(
      input(fixture, report, snapshot),
      dependencies(resolver(), report),
    );
    const index = readIndex(fixture);
    const manifest = JSON.parse(readFileSync(fixture.manifest, "utf8")) as { docs: string[] };
    const readme = readFileSync(second.readme_path, "utf8");

    expect(index.status).toBe("PASS");
    expect(index.entries.map((entry) => entry.identity)).toEqual([
      "AlphaTOP",
      "COMP.loadTox",
      "OP",
      "ZetaTOP",
    ]);
    expect(index.entries.every((entry) => entry.status === "available")).toBe(true);
    expect(firstHashes).toEqual(second.files.map((file) => [file.path, file.sha256]));
    expect(readFileSync(second.index_path)).toEqual(firstIndexBytes);
    expect(second.files.find((file) => file.path.endsWith("index.json"))?.sha256).toBe(
      createHash("sha256").update(firstIndexBytes).digest("hex"),
    );
    expect(manifest.docs).toEqual([...manifest.docs].sort());
    expect(manifest.docs).not.toContain("docs/td-help/old.md");
    expect(manifest.docs).toContain("docs/td-help/operator/alphatop.md");
    expect(manifest.docs).toContain("docs/td-help/python/comp-loadtox.md");
    expect(readme).toContain("[operator: AlphaTOP](operator/alphatop.md)");
    expect(first.post_attach_roundtrip_verified).toBe(true);
    expect(temporaryEntries(fixture)).toEqual([]);
    expect(firstDependencies.verifyArtifactRoundtrip).toHaveBeenCalledWith({
      quarantine_port: 9_981,
      expected: report,
    });

    for (const call of docs.mock.calls) {
      const request = call[0] as TdDocsLookupRequest;
      expect(request.source).toBe("installed");
      expect(request.web_fallback).toBe(false);
      expect(["operator", "python"]).toContain(request.kind);
    }
  });

  it("marks build mismatch UNVERIFIED and never writes mismatched page bodies", async () => {
    const fixture = packageFixture();
    const report = roundtrip({ NoiseTOP: 1 });
    const docs = resolver((request) => foundDocs(request, { build: "2026.10000" }));

    const result = await attachComponentHelpSnapshot(
      input(fixture, report),
      dependencies(docs, report),
    );
    const index = readIndex(fixture);

    expect(result.status).toBe("UNVERIFIED");
    expect(index.entries).toMatchObject([
      { identity: "NoiseTOP", status: "unavailable", reason: "installed_build_mismatch" },
    ]);
    expect(existsSync(join(fixture.helpRoot, "operator", "noisetop.md"))).toBe(false);
  });

  it("does not replace a missing preferred section or unavailable installed page with fallback", async () => {
    const fixture = packageFixture();
    const report = roundtrip({ NoiseTOP: 1 });
    const docs = resolver((request) => {
      if (request.kind === "python") {
        return {
          ...foundDocs(request),
          status: "source_unavailable",
          page: undefined,
          content: undefined,
          selected_section: undefined,
        };
      }
      if (request.section === "Parameters_-_Common_Page") {
        return {
          ...foundDocs(request),
          status: "section_not_found",
          content: undefined,
          selected_section: undefined,
        };
      }
      return foundDocs(request);
    });

    await attachComponentHelpSnapshot(
      input(fixture, report, helpSnapshot({ python_apis: ["OP"] })),
      dependencies(docs, report),
    );
    const index = readIndex(fixture);

    expect(index.status).toBe("UNVERIFIED");
    expect(index.entries).toMatchObject([
      { identity: "NoiseTOP", reason: "preferred_section_missing" },
      { identity: "OP", reason: "installed_docs_unavailable" },
    ]);
    expect(
      docs.mock.calls.every(
        ([request]) =>
          (request as TdDocsLookupRequest).source === "installed" &&
          !(request as TdDocsLookupRequest).web_fallback,
      ),
    ).toBe(true);
  });

  it("applies operator item and total byte caps in stable order", async () => {
    const fixture = packageFixture();
    const report = roundtrip({ AlphaTOP: 1, BetaTOP: 1, GammaTOP: 1, ZetaTOP: 1 });
    const docs = resolver((request) => foundDocs(request, { content: "x".repeat(6_000) }));

    await attachComponentHelpSnapshot(
      input(
        fixture,
        report,
        helpSnapshot({
          max_operator_types: 3,
          max_chars_per_section: 6_000,
          max_total_bytes: 32_768,
        }),
      ),
      dependencies(docs, report),
    );
    const index = readIndex(fixture);

    expect(index.status).toBe("UNVERIFIED");
    expect(index.entries.find((entry) => entry.identity === "ZetaTOP")).toMatchObject({
      status: "truncated",
      reason: "operator_type_cap",
    });
    expect(
      index.entries.some((entry) => entry.status === "truncated" && entry.reason === "byte_cap"),
    ).toBe(true);
    expect(docs).toHaveBeenCalledTimes(6);
  });

  it("rejects normalized filename collisions without calling the docs resolver", async () => {
    const fixture = packageFixture();
    const report = roundtrip({ "Foo.Bar": 1, Foo_Bar: 1 });
    const docs = resolver();

    await attachComponentHelpSnapshot(input(fixture, report), dependencies(docs, report));
    const index = readIndex(fixture);

    expect(index.entries).toMatchObject([
      { status: "unavailable", reason: "filename_collision" },
      { status: "unavailable", reason: "filename_collision" },
    ]);
    expect(docs).not.toHaveBeenCalled();
  });

  it("cleans staging and preserves the old subtree when a page write or stage hash fails", async () => {
    const pageFailure = packageFixture(true);
    const hashFailure = packageFixture(true);
    const report = roundtrip();
    const originalPageManifest = readFileSync(pageFailure.manifest);
    const originalHashManifest = readFileSync(hashFailure.manifest);

    await expect(
      attachComponentHelpSnapshot(input(pageFailure, report), {
        ...dependencies(resolver(), report),
        hooks: {
          beforeWriteFile(path) {
            if (path.startsWith("operator/")) throw new Error("induced page failure");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "snapshot_failed" });
    await expect(
      attachComponentHelpSnapshot(input(hashFailure, report), {
        ...dependencies(resolver(), report),
        hooks: {
          afterStageWritten(stagePath) {
            writeFileSync(join(stagePath, "index.json"), "corrupted", "utf8");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "stage_verification_failed" });

    expect(readFileSync(pageFailure.manifest)).toEqual(originalPageManifest);
    expect(readFileSync(hashFailure.manifest)).toEqual(originalHashManifest);
    expect(readFileSync(join(pageFailure.helpRoot, "old.md"), "utf8")).toBe("old snapshot\n");
    expect(readFileSync(join(hashFailure.helpRoot, "old.md"), "utf8")).toBe("old snapshot\n");
    expect(temporaryEntries(pageFailure)).toEqual([]);
    expect(temporaryEntries(hashFailure)).toEqual([]);
  });

  it("restores both manifest and owned subtree after manifest promotion or final roundtrip failure", async () => {
    const promotionFailure = packageFixture(true);
    const roundtripFailure = packageFixture(true);
    const report = roundtrip();
    const promotionManifest = readFileSync(promotionFailure.manifest);
    const roundtripManifest = readFileSync(roundtripFailure.manifest);

    await expect(
      attachComponentHelpSnapshot(input(promotionFailure, report), {
        ...dependencies(resolver(), report),
        hooks: {
          afterManifestPromoted() {
            throw new Error("induced promotion failure");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "snapshot_failed" });
    await expect(
      attachComponentHelpSnapshot(input(roundtripFailure, report), {
        resolveDocs: resolver(),
        verifyArtifactRoundtrip: vi.fn(async () => ({ ...report, artifact_sha256: OTHER_SHA })),
      }),
    ).rejects.toMatchObject({ code: "post_attach_roundtrip_changed" });

    expect(readFileSync(promotionFailure.manifest)).toEqual(promotionManifest);
    expect(readFileSync(roundtripFailure.manifest)).toEqual(roundtripManifest);
    expect(readFileSync(join(promotionFailure.helpRoot, "old.md"), "utf8")).toBe("old snapshot\n");
    expect(readFileSync(join(roundtripFailure.helpRoot, "old.md"), "utf8")).toBe("old snapshot\n");
    expect(temporaryEntries(promotionFailure)).toEqual([]);
    expect(temporaryEntries(roundtripFailure)).toEqual([]);
  });

  it("rejects symlinked owned trees before resolving or mutating docs", async () => {
    const fixture = packageFixture();
    const external = mkdtempSync(join(tmpdir(), "tdmcp-component-help-external-"));
    roots.push(external);
    mkdirSync(join(fixture.root, "docs"), { recursive: true });
    symlinkSync(external, fixture.helpRoot);
    const docs = resolver();
    const report = roundtrip();

    await expect(
      attachComponentHelpSnapshot(input(fixture, report), dependencies(docs, report)),
    ).rejects.toMatchObject({ code: "symlink_rejected" });
    expect(docs).not.toHaveBeenCalled();
  });
});
