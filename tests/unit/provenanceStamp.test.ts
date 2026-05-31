import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProvenanceSidecarSchema,
  provenanceStampImpl,
} from "../../src/tools/library/provenanceStamp.js";
import type { ToolContext } from "../../src/tools/types.js";

// Minimal stub ctx — no client needed (offline tool)
const ctx = {} as unknown as ToolContext;

let tmpDir: string;
let artifactPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "provenance-test-"));
  artifactPath = join(tmpDir, "test.tox");
  writeFileSync(artifactPath, "fake tox bytes 0123456789", "utf8");
});

afterEach(() => {
  // tmpdir is OS-managed; leave cleanup to the OS to avoid flakiness
});

function indepSha256(filePath: string): string {
  const data = readFileSync(filePath);
  return createHash("sha256").update(data).digest("hex");
}

describe("provenanceStamp", () => {
  it("happy path — sidecar exists, schema valid, sha256 + size correct", async () => {
    const result = await provenanceStampImpl(ctx, {
      artifact_path: artifactPath,
      artifact_kind: "tox",
      source: { comp_path: "/project1", tool: "make_portable_tox" },
      author: "test-author",
      tags: ["feedback", "tunnel"],
      notes: "unit test note",
      extra: { nodes: 7 },
      overwrite: true,
      include_git: false,
    });

    expect(result.isError).toBeFalsy();

    const sidecarPath = `${artifactPath}.provenance.json`;
    const raw = JSON.parse(readFileSync(sidecarPath, "utf8")) as unknown;
    const sidecar = ProvenanceSidecarSchema.parse(raw);

    expect(sidecar.schema_version).toBe(1);
    expect(sidecar.artifact.sha256).toBe(indepSha256(artifactPath));
    expect(sidecar.artifact.size).toBe(statSync(artifactPath).size);

    const pkgVersion = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"),
    ) as { version: string };
    expect(sidecar.toolchain.tdmcp_version).toBe(pkgVersion.version);
  });

  it("idempotency — second stamp overwrites, sha256 unchanged, created_at differs", async () => {
    const args = {
      artifact_path: artifactPath,
      artifact_kind: "tox" as const,
      source: {},
      overwrite: true,
      include_git: false,
      tags: [],
      extra: {},
    };

    await provenanceStampImpl(ctx, args);
    const sidecar1 = ProvenanceSidecarSchema.parse(
      JSON.parse(readFileSync(`${artifactPath}.provenance.json`, "utf8")),
    );

    // small delay to ensure created_at differs
    await new Promise((r) => setTimeout(r, 10));
    await provenanceStampImpl(ctx, args);
    const sidecar2 = ProvenanceSidecarSchema.parse(
      JSON.parse(readFileSync(`${artifactPath}.provenance.json`, "utf8")),
    );

    expect(sidecar1.artifact.sha256).toBe(sidecar2.artifact.sha256);
    expect(sidecar1.created_at).not.toBe(sidecar2.created_at);
  });

  it("overwrite guard — returns isError when sidecar exists and overwrite=false", async () => {
    await provenanceStampImpl(ctx, {
      artifact_path: artifactPath,
      artifact_kind: "other",
      source: {},
      overwrite: true,
      include_git: false,
      tags: [],
      extra: {},
    });

    const result = await provenanceStampImpl(ctx, {
      artifact_path: artifactPath,
      artifact_kind: "other",
      source: {},
      overwrite: false,
      include_git: false,
      tags: [],
      extra: {},
    });

    expect(result.isError).toBe(true);
    const text = result.content[0];
    expect(text?.type === "text" && text.text).toMatch(/overwrite=false/);
  });

  it("missing artifact returns isError", async () => {
    const result = await provenanceStampImpl(ctx, {
      artifact_path: join(tmpDir, "does-not-exist.tox"),
      artifact_kind: "tox",
      source: {},
      overwrite: true,
      include_git: false,
      tags: [],
      extra: {},
    });
    expect(result.isError).toBe(true);
    const text = result.content[0];
    expect(text?.type === "text" && text.text).toMatch(/not found/i);
  });

  it("source/extra round-trip survives into JSON", async () => {
    await provenanceStampImpl(ctx, {
      artifact_path: artifactPath,
      artifact_kind: "recipe_bundle",
      source: { comp_path: "/my/comp", recipe_id: "wave_gen", tool: "export_recipe_bundle" },
      tags: ["wave", "gen"],
      extra: { connections: 9 },
      overwrite: true,
      include_git: false,
    });

    const sidecar = ProvenanceSidecarSchema.parse(
      JSON.parse(readFileSync(`${artifactPath}.provenance.json`, "utf8")),
    );

    expect(sidecar.source.comp_path).toBe("/my/comp");
    expect(sidecar.source.recipe_id).toBe("wave_gen");
    expect(sidecar.source.tool).toBe("export_recipe_bundle");
    expect(sidecar.tags).toEqual(["wave", "gen"]);
    expect(sidecar.extra).toEqual({ connections: 9 });
  });

  it("include_git: false — sidecar has no git key", async () => {
    await provenanceStampImpl(ctx, {
      artifact_path: artifactPath,
      artifact_kind: "other",
      source: {},
      overwrite: true,
      include_git: false,
      tags: [],
      extra: {},
    });

    const raw = JSON.parse(readFileSync(`${artifactPath}.provenance.json`, "utf8")) as {
      git?: unknown;
    };
    expect(raw.git).toBeUndefined();
  });

  it("TDMCP_AUTHOR env var sets author", async () => {
    process.env.TDMCP_AUTHOR = "alice";
    try {
      await provenanceStampImpl(ctx, {
        artifact_path: artifactPath,
        artifact_kind: "other",
        source: {},
        overwrite: true,
        include_git: false,
        tags: [],
        extra: {},
      });
      const sidecar = ProvenanceSidecarSchema.parse(
        JSON.parse(readFileSync(`${artifactPath}.provenance.json`, "utf8")),
      );
      expect(sidecar.author).toBe("alice");
    } finally {
      delete process.env.TDMCP_AUTHOR;
    }
  });

  it("artifact_kind tox round-trips to kind: tox", async () => {
    await provenanceStampImpl(ctx, {
      artifact_path: artifactPath,
      artifact_kind: "tox",
      source: {},
      overwrite: true,
      include_git: false,
      tags: [],
      extra: {},
    });
    const sidecar = ProvenanceSidecarSchema.parse(
      JSON.parse(readFileSync(`${artifactPath}.provenance.json`, "utf8")),
    );
    expect(sidecar.kind).toBe("tox");
  });
});
