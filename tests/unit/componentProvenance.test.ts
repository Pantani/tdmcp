import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  automaticComponentProvenanceOptionsSchema,
  buildComponentProvenance,
  type ComponentProvenanceArtifact,
  canonicalJsonBytes,
  captureComponentGit,
  componentProvenanceBuildSchema,
  componentProvenanceRecordSchema,
  evaluateProvenancePolicy,
  type PairPromotionPhase,
  promoteComponentPair,
  sha256Bytes,
} from "../../src/tools/library/componentProvenance.js";

const OPERATION_ID = "provenance_operation_000001";
const CREATED_AT = "2026-07-15T18:00:00.000Z";
const SECRET = "secret-env-value-must-not-appear";
const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-component-provenance-"));
  dirs.push(dir);
  return dir;
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildInput(artifactPath: string, manifest: unknown = { name: "Widget", version: 1 }) {
  return {
    artifact_path: artifactPath,
    artifact_basename: "widget.tox",
    manifest,
    source: {
      comp_path: "/project1/widget",
      op_type: "baseCOMP",
      operator_id: "42",
    },
    export_mode: "portable" as const,
    toolchain: {
      tdmcp_version: "0.13.1",
      td_version: "2025.32820",
      td_build: 32820,
      project_save_build: 32700,
    },
    git: { available: true as const, commit: "a".repeat(40), dirty: false },
    operation_id: OPERATION_ID,
    created_at: CREATED_AT,
  };
}

async function preparedPair(dir: string): Promise<{
  temp: string;
  final: string;
  provenance: ComponentProvenanceArtifact;
}> {
  const temp = join(dir, ".widget.tmp.tox");
  const final = join(dir, "widget.tox");
  writeFileSync(temp, "NEW-TOX-BYTES", "utf8");
  return {
    temp,
    final,
    provenance: await buildComponentProvenance(buildInput(temp)),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("component provenance canonical record", () => {
  it("keeps provenance options additive and bounds clean-release commit input", () => {
    expect(automaticComponentProvenanceOptionsSchema.parse({})).toEqual({
      provenance_policy: "record",
    });
    expect(
      automaticComponentProvenanceOptionsSchema.safeParse({
        provenance_policy: "record",
        expected_git_commit: "a".repeat(40),
      }).success,
    ).toBe(false);
    expect(
      automaticComponentProvenanceOptionsSchema.safeParse({
        provenance_policy: "require_clean",
        expected_git_commit: "A".repeat(40),
      }).success,
    ).toBe(false);
  });

  it("sorts canonical object keys and bounds unsupported values", () => {
    expect(canonicalJsonBytes({ z: 1, a: { y: 2, b: 3 } }).toString("utf8")).toBe(
      '{"a":{"b":3,"y":2},"z":1}\n',
    );
    expect(() => canonicalJsonBytes({ invalid: undefined })).toThrow(/undefined/);
    expect(() => canonicalJsonBytes({ invalid: Number.NaN })).toThrow(/non-finite/);
  });

  it("builds a strict v2 record in manifest-then-artifact hash order", async () => {
    const dir = workspace();
    const artifact = join(dir, ".widget.tmp.tox");
    const bytesBefore = Buffer.from("FINAL-TOX-BYTES");
    writeFileSync(artifact, bytesBefore);
    const manifest = { version: 1, assets: ["widget.tox"], id: "widget" };

    const built = await buildComponentProvenance(buildInput(artifact, manifest));
    const parsed = componentProvenanceRecordSchema.parse(JSON.parse(built.bytes.toString("utf8")));

    expect(parsed.schema_version).toBe(2);
    expect(parsed.artifact).toEqual({
      basename: "widget.tox",
      sha256: sha(bytesBefore),
      size_bytes: bytesBefore.byteLength,
    });
    expect(parsed.manifest_sha256).toBe(sha(canonicalJsonBytes(manifest)));
    expect(parsed.source.comp_path).toBe("/project1/widget");
    expect(readFileSync(artifact)).toEqual(bytesBefore);
    expect(built.provenance_sha256).toBe(sha256Bytes(built.bytes));
    expect(built.bytes.toString("utf8")).not.toContain(dir);
  });

  it("produces byte-identical recovery output for one operation and timestamp", async () => {
    const dir = workspace();
    const artifact = join(dir, ".widget.tmp.tox");
    writeFileSync(artifact, "STABLE-TOX", "utf8");
    const input = buildInput(artifact, { b: 2, a: 1 });

    const first = await buildComponentProvenance(input);
    const second = await buildComponentProvenance(input);

    expect(second.bytes).toEqual(first.bytes);
    expect(second.provenance_sha256).toBe(first.provenance_sha256);
  });

  it("changes the manifest hash without changing final TOX bytes/hash", async () => {
    const dir = workspace();
    const artifact = join(dir, ".widget.tmp.tox");
    writeFileSync(artifact, "UNCHANGED-TOX", "utf8");

    const first = await buildComponentProvenance(buildInput(artifact, { version: 1 }));
    const second = await buildComponentProvenance(buildInput(artifact, { version: 2 }));

    expect(first.record.artifact.sha256).toBe(second.record.artifact.sha256);
    expect(first.manifest_sha256).not.toBe(second.manifest_sha256);
    expect(readFileSync(artifact, "utf8")).toBe("UNCHANGED-TOX");
  });

  it("strictly rejects extra secret-bearing input instead of serializing it", () => {
    const candidate = {
      ...buildInput("/tmp/widget.tox"),
      environment: { TOKEN: SECRET },
      git_diff: SECRET,
      filesystem_source_path: `/private/${SECRET}`,
    };
    expect(componentProvenanceBuildSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("bounded git capture and policy", () => {
  it("records only commit/dirty and never root, status contents or diffs", () => {
    const runner = (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse") return { status: 0, stdout: `${"b".repeat(40)}\n` };
      return { status: 0, stdout: ` M source.ts ${SECRET}\n${SECRET}-diff` };
    };

    const git = captureComponentGit(`/private/root/${SECRET}`, runner);

    expect(git).toEqual({ available: true, commit: "b".repeat(40), dirty: true });
    expect(JSON.stringify(git)).not.toContain(SECRET);
  });

  it("treats unavailable git honestly in record mode and fails require_clean", () => {
    const unavailable = { available: false } as const;
    expect(evaluateProvenancePolicy("record", unavailable)).toEqual({
      ok: true,
      verdict: "PASS",
      git: unavailable,
    });
    expect(evaluateProvenancePolicy("require_clean", unavailable)).toMatchObject({
      ok: false,
      code: "provenance_git_unavailable",
    });
  });

  it("fails dirty and expected-commit mismatch before export", () => {
    const dirty = { available: true as const, commit: "c".repeat(40), dirty: true };
    const clean = { ...dirty, dirty: false };
    expect(evaluateProvenancePolicy("require_clean", dirty)).toMatchObject({
      ok: false,
      code: "provenance_dirty",
    });
    expect(evaluateProvenancePolicy("require_clean", clean, "d".repeat(40))).toMatchObject({
      ok: false,
      code: "provenance_source_stale",
    });
    expect(evaluateProvenancePolicy("require_clean", clean, "c".repeat(40))).toMatchObject({
      ok: true,
      verdict: "PASS",
    });
  });
});

describe("recoverable TOX/provenance pair promotion", () => {
  it("promotes and readback-verifies both files while removing journal/backups", async () => {
    const dir = workspace();
    const pair = await preparedPair(dir);
    writeFileSync(pair.final, "OLD-TOX", "utf8");
    writeFileSync(`${pair.final}.provenance.json`, "OLD-PROVENANCE", "utf8");

    const promoted = await promoteComponentPair({
      temp_tox_path: pair.temp,
      final_tox_path: pair.final,
      provenance_bytes: pair.provenance.bytes,
      operation_id: OPERATION_ID,
    });

    expect(readFileSync(pair.final, "utf8")).toBe("NEW-TOX-BYTES");
    expect(readFileSync(`${pair.final}.provenance.json`)).toEqual(pair.provenance.bytes);
    expect(promoted.artifact_sha256).toBe(pair.provenance.record.artifact.sha256);
    expect(promoted.provenance_sha256).toBe(pair.provenance.provenance_sha256);
    expect(promoted.journal_removed).toBe(true);
    expect(readdirSync(dir).filter((name) => name.includes(".tdmcp-"))).toEqual([]);
  });

  it.each<PairPromotionPhase>([
    "promoted_tox",
    "promoted_provenance",
  ])("restores the last-known-good pair after induced %s failure", async (failurePhase) => {
    const dir = workspace();
    const pair = await preparedPair(dir);
    writeFileSync(pair.final, "OLD-TOX", "utf8");
    writeFileSync(`${pair.final}.provenance.json`, "OLD-PROVENANCE", "utf8");

    await expect(
      promoteComponentPair({
        temp_tox_path: pair.temp,
        final_tox_path: pair.final,
        provenance_bytes: pair.provenance.bytes,
        operation_id: OPERATION_ID,
        hooks: {
          onPhase: (phase) => {
            if (phase === failurePhase) throw new Error(`induced ${failurePhase}`);
          },
        },
      }),
    ).rejects.toThrow(/promotion failed/);

    expect(readFileSync(pair.final, "utf8")).toBe("OLD-TOX");
    expect(readFileSync(`${pair.final}.provenance.json`, "utf8")).toBe("OLD-PROVENANCE");
    expect(readdirSync(dir).filter((name) => name.includes(".tdmcp-"))).toEqual([]);
  });

  it("removes a newly-created partial pair after failure", async () => {
    const dir = workspace();
    const pair = await preparedPair(dir);

    await expect(
      promoteComponentPair({
        temp_tox_path: pair.temp,
        final_tox_path: pair.final,
        provenance_bytes: pair.provenance.bytes,
        operation_id: OPERATION_ID,
        hooks: {
          onPhase: (phase) => {
            if (phase === "promoted_tox") throw new Error("induced");
          },
        },
      }),
    ).rejects.toThrow();

    expect(existsSync(pair.final)).toBe(false);
    expect(existsSync(`${pair.final}.provenance.json`)).toBe(false);
  });

  it("recovers a stale journal/backup before retry without losing the old pair", async () => {
    const dir = workspace();
    const pair = await preparedPair(dir);
    const prefix = `.tdmcp-widget.tox-${OPERATION_ID}`;
    writeFileSync(pair.final, "PARTIAL-NEW-TOX", "utf8");
    writeFileSync(`${pair.final}.provenance.json`, "PARTIAL-NEW-PROVENANCE", "utf8");
    writeFileSync(join(dir, `${prefix}.bak.tox`), "OLD-TOX", "utf8");
    writeFileSync(join(dir, `${prefix}.bak.provenance.json`), "OLD-PROVENANCE", "utf8");
    writeFileSync(
      join(dir, `${prefix}.journal.json`),
      canonicalJsonBytes({
        schema_version: 1,
        operation_id: OPERATION_ID,
        phase: "promoted_provenance",
        artifact: "widget.tox",
        provenance: "widget.tox.provenance.json",
        had_artifact: true,
        had_provenance: true,
      }),
    );

    await expect(
      promoteComponentPair({
        temp_tox_path: pair.temp,
        final_tox_path: pair.final,
        provenance_bytes: pair.provenance.bytes,
        operation_id: OPERATION_ID,
        hooks: {
          onPhase: (phase) => {
            if (phase === "prepared") throw new Error(`induced ${SECRET}`);
          },
        },
      }),
    ).rejects.toThrow("previous pair restored");

    expect(readFileSync(pair.final, "utf8")).toBe("OLD-TOX");
    expect(readFileSync(`${pair.final}.provenance.json`, "utf8")).toBe("OLD-PROVENANCE");
    expect(readdirSync(dir).join(" ")).not.toContain(".tdmcp-");
  });

  it("does not reflect injected filesystem/hook error content", async () => {
    const dir = workspace();
    const pair = await preparedPair(dir);
    let message = "";
    try {
      await promoteComponentPair({
        temp_tox_path: pair.temp,
        final_tox_path: pair.final,
        provenance_bytes: pair.provenance.bytes,
        operation_id: OPERATION_ID,
        hooks: {
          onPhase: () => {
            throw new Error(SECRET);
          },
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("previous pair restored");
    expect(message).not.toContain(SECRET);
  });

  it("recovers response loss idempotently from the already verified final pair", async () => {
    const dir = workspace();
    const pair = await preparedPair(dir);
    const first = await promoteComponentPair({
      temp_tox_path: pair.temp,
      final_tox_path: pair.final,
      provenance_bytes: pair.provenance.bytes,
      operation_id: OPERATION_ID,
    });

    const retry = await promoteComponentPair({
      temp_tox_path: pair.temp,
      final_tox_path: pair.final,
      provenance_bytes: pair.provenance.bytes,
      operation_id: OPERATION_ID,
    });

    expect(first.deduplicated).toBe(false);
    expect(retry).toMatchObject({
      artifact_sha256: first.artifact_sha256,
      provenance_sha256: first.provenance_sha256,
      deduplicated: true,
      journal_removed: true,
    });
    expect(basename(retry.provenance_path)).toBe("widget.tox.provenance.json");
  });
});
