import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { curatedCollectionPackImpl } from "../../src/tools/library/curatedCollectionPack.js";
import type { ToolContext } from "../../src/tools/types.js";

// Minimal stub ctx — offline tool (no client; needs logger stub)
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
} as unknown as ToolContext;

let tmpDir: string;
let vaultDir: string;
let outDir: string;

function sha256(filePath: string): string {
  const data = readFileSync(filePath);
  return createHash("sha256").update(data).digest("hex");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ccp-test-"));
  vaultDir = join(tmpDir, "vault");
  outDir = join(tmpDir, "out");
  mkdirSync(vaultDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  // Create fake vault assets
  writeFileSync(join(vaultDir, "foo.recipe.json"), JSON.stringify({ id: "foo" }), "utf8");
  writeFileSync(join(vaultDir, "bar.tox"), "fake tox bytes", "utf8");
  writeFileSync(join(vaultDir, "baz.look.json"), JSON.stringify({ id: "baz" }), "utf8");
  writeFileSync(join(vaultDir, "qux.png"), "fake png bytes", "utf8");
});

afterEach(() => {
  // OS cleans up tmpdir
});

describe("curatedCollectionPack", () => {
  const fooItem = { kind: "recipe" as const, path: "foo.recipe.json" };
  const barItem = { kind: "component" as const, path: "bar.tox" };
  const bazItem = { kind: "look" as const, path: "baz.look.json" };
  const quxItem = { kind: "asset" as const, path: "qux.png" };
  const fourItems = [fooItem, barItem, bazItem, quxItem];

  it("pack happy path — files copied, manifest valid, checksums present, provenance sidecars exist", async () => {
    const result = await curatedCollectionPackImpl(ctx, {
      action: "pack",
      name: "demo",
      out_dir: outDir,
      items: fourItems,
      vault_path: vaultDir,
      include_provenance: true,
      tags: ["test"],
      overwrite: false,
      verify_on_unpack: true,
    });

    expect(result.isError).toBeFalsy();

    const packDir = join(outDir, "demo.pack");

    // 1a. Packed files exist and match source hashes
    const fooSrc = join(vaultDir, "foo.recipe.json");
    const fooPacked = join(packDir, "recipes", "foo.recipe.json");
    expect(existsSync(fooPacked)).toBe(true);
    expect(sha256(fooPacked)).toBe(sha256(fooSrc));

    // 1b. pack.manifest.json has 4 items with correct pack_path, sha256, size
    const manifest = JSON.parse(readFileSync(join(packDir, "pack.manifest.json"), "utf8")) as {
      kind: string;
      schema_version: number;
      name: string;
      items: Array<{ kind: string; pack_path: string; sha256: string; size: number }>;
    };
    expect(manifest.kind).toBe("tdmcp-curated-pack");
    expect(manifest.schema_version).toBe(1);
    expect(manifest.name).toBe("demo");
    expect(manifest.items).toHaveLength(4);

    const fooItem = manifest.items.find((i) => i.pack_path === "recipes/foo.recipe.json");
    expect(fooItem).toBeTruthy();
    expect(fooItem?.sha256).toBe(sha256(fooPacked));
    expect(fooItem?.size).toBeGreaterThan(0);

    const barItem = manifest.items.find((i) => i.pack_path === "components/bar.tox");
    expect(barItem).toBeTruthy();

    const bazItem = manifest.items.find((i) => i.pack_path === "looks/baz.look.json");
    expect(bazItem).toBeTruthy();

    const quxItem = manifest.items.find((i) => i.pack_path === "assets/qux.png");
    expect(quxItem).toBeTruthy();

    // 1c. tdmcp-checksums.json exists and has correct kind; does NOT list pack.manifest.json or *.provenance.json
    const checksumPath = join(packDir, "tdmcp-checksums.json");
    expect(existsSync(checksumPath)).toBe(true);
    const checksumManifest = JSON.parse(readFileSync(checksumPath, "utf8")) as {
      kind: string;
      files: Array<{ path: string }>;
    };
    expect(checksumManifest.kind).toBe("tdmcp-checksum-manifest");
    const paths = checksumManifest.files.map((f) => f.path);
    expect(paths.some((p) => p.includes("pack.manifest.json"))).toBe(false);
    expect(paths.some((p) => p.includes(".provenance.json"))).toBe(false);

    // 1d. Provenance sidecars exist
    expect(existsSync(`${fooPacked}.provenance.json`)).toBe(true);
    expect(existsSync(`${join(packDir, "components", "bar.tox")}.provenance.json`)).toBe(true);
  });

  it("pack overwrite=false on existing dir → error", async () => {
    // First pack
    await curatedCollectionPackImpl(ctx, {
      action: "pack",
      name: "demo",
      out_dir: outDir,
      items: [fooItem],
      vault_path: vaultDir,
      include_provenance: false,
      tags: [],
      overwrite: false,
      verify_on_unpack: true,
    });

    // Second pack — must fail
    const result = await curatedCollectionPackImpl(ctx, {
      action: "pack",
      name: "demo",
      out_dir: outDir,
      items: [fooItem],
      vault_path: vaultDir,
      include_provenance: false,
      tags: [],
      overwrite: false,
      verify_on_unpack: true,
    });

    expect(result.isError).toBe(true);
    const text = result.content[0];
    expect(text?.type === "text" && text.text).toMatch(/overwrite=false/);
  });

  it("pack empty items → error", async () => {
    const result = await curatedCollectionPackImpl(ctx, {
      action: "pack",
      name: "demo",
      out_dir: outDir,
      items: [],
      vault_path: vaultDir,
      include_provenance: false,
      tags: [],
      overwrite: false,
      verify_on_unpack: true,
    });
    expect(result.isError).toBe(true);
    const text = result.content[0];
    expect(text?.type === "text" && text.text).toMatch(/empty/i);
  });

  it("unpack happy path — round-trip restores files byte-identical and verify_on_unpack passes", async () => {
    // Pack first
    await curatedCollectionPackImpl(ctx, {
      action: "pack",
      name: "round",
      out_dir: outDir,
      items: fourItems,
      vault_path: vaultDir,
      include_provenance: false,
      tags: [],
      overwrite: false,
      verify_on_unpack: true,
    });

    const destDir = join(tmpDir, "restored");
    mkdirSync(destDir, { recursive: true });

    const unpackResult = await curatedCollectionPackImpl(ctx, {
      action: "unpack",
      name: "round",
      out_dir: destDir,
      pack_path: join(outDir, "round.pack"),
      items: [],
      include_provenance: false,
      tags: [],
      overwrite: false,
      verify_on_unpack: true,
    });

    expect(unpackResult.isError).toBeFalsy();

    // All 4 files restored byte-identical
    expect(sha256(join(destDir, "recipes", "foo.recipe.json"))).toBe(
      sha256(join(vaultDir, "foo.recipe.json")),
    );
    expect(sha256(join(destDir, "components", "bar.tox"))).toBe(sha256(join(vaultDir, "bar.tox")));
    expect(sha256(join(destDir, "looks", "baz.look.json"))).toBe(
      sha256(join(vaultDir, "baz.look.json")),
    );
    expect(sha256(join(destDir, "assets", "qux.png"))).toBe(sha256(join(vaultDir, "qux.png")));

    const sc = (unpackResult as { structuredContent?: { verify?: { ok?: boolean } } })
      .structuredContent;
    // verify_on_unpack ran — ok should be true or null (strict=false allows extra sidecars)
    expect(sc?.verify?.ok === false).toBe(false);
  });

  it("unpack tamper — flip one byte, unpack returns isError citing mismatch", async () => {
    await curatedCollectionPackImpl(ctx, {
      action: "pack",
      name: "tamper",
      out_dir: outDir,
      items: [fooItem],
      vault_path: vaultDir,
      include_provenance: false,
      tags: [],
      overwrite: false,
      verify_on_unpack: true,
    });

    // Corrupt the packed recipe file
    const packedFile = join(outDir, "tamper.pack", "recipes", "foo.recipe.json");
    writeFileSync(packedFile, "CORRUPTED", "utf8");

    const destDir = join(tmpDir, "tampered-restore");
    mkdirSync(destDir, { recursive: true });

    const result = await curatedCollectionPackImpl(ctx, {
      action: "unpack",
      name: "tamper",
      out_dir: destDir,
      pack_path: join(outDir, "tamper.pack"),
      items: [],
      include_provenance: false,
      tags: [],
      overwrite: false,
      verify_on_unpack: true,
    });

    expect(result.isError).toBe(true);
  });

  it("unpack path traversal — manifest with ../evil pack_path → error, no write outside dest", async () => {
    // Build a minimal pack dir with a tampered manifest
    const evilPackDir = join(tmpDir, "evil.pack");
    mkdirSync(evilPackDir, { recursive: true });

    // Write a fake checksums manifest so verify passes (verify_on_unpack=false avoids that path)
    const fakeManifest = {
      kind: "tdmcp-curated-pack",
      schema_version: 1,
      name: "evil",
      tags: [],
      created_at: new Date().toISOString(),
      tdmcp_version: "0.0.0",
      author: "test",
      items: [
        {
          kind: "recipe",
          source_path: "/tmp/foo",
          pack_path: "../evil-escape",
          alias: "evil-escape",
          sha256: "abc",
          size: 3,
        },
      ],
      integrity_manifest: "tdmcp-checksums.json",
    };
    writeFileSync(join(evilPackDir, "pack.manifest.json"), JSON.stringify(fakeManifest), "utf8");

    const destDir = join(tmpDir, "evil-dest");
    mkdirSync(destDir, { recursive: true });

    const result = await curatedCollectionPackImpl(ctx, {
      action: "unpack",
      name: "evil",
      out_dir: destDir,
      pack_path: evilPackDir,
      items: [],
      include_provenance: false,
      tags: [],
      overwrite: false,
      verify_on_unpack: false,
    });

    expect(result.isError).toBe(true);
    const text = result.content[0];
    expect(text?.type === "text" && text.text).toMatch(/traversal|unsafe/i);

    // File should NOT exist outside dest
    expect(existsSync(join(tmpDir, "evil-escape"))).toBe(false);
  });

  it("alias override — item lands at recipes/renamed.json (alias replaces basename, ext preserved)", async () => {
    const result = await curatedCollectionPackImpl(ctx, {
      action: "pack",
      name: "alias-test",
      out_dir: outDir,
      items: [{ kind: "recipe", path: "foo.recipe.json", alias: "renamed" }],
      vault_path: vaultDir,
      include_provenance: false,
      tags: [],
      overwrite: false,
      verify_on_unpack: true,
    });

    expect(result.isError).toBeFalsy();

    // extname("foo.recipe.json") === ".json"; alias "renamed" + ".json" = "renamed.json"
    const packed = join(outDir, "alias-test.pack", "recipes", "renamed.json");
    expect(existsSync(packed)).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(outDir, "alias-test.pack", "pack.manifest.json"), "utf8"),
    ) as { items: Array<{ pack_path: string; alias: string }> };
    const item = manifest.items[0];
    expect(item?.pack_path).toBe("recipes/renamed.json");
    expect(item?.alias).toBe("renamed");
  });

  it("include_provenance=false — no sidecars written", async () => {
    await curatedCollectionPackImpl(ctx, {
      action: "pack",
      name: "no-prov",
      out_dir: outDir,
      items: [fooItem],
      vault_path: vaultDir,
      include_provenance: false,
      tags: [],
      overwrite: false,
      verify_on_unpack: true,
    });

    const packed = join(outDir, "no-prov.pack", "recipes", "foo.recipe.json");
    expect(existsSync(packed)).toBe(true);
    expect(existsSync(`${packed}.provenance.json`)).toBe(false);
  });
});
