import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmpRoots: string[] = [];

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-validate-recipes-"));
  tmpRoots.push(dir);
  return dir;
}

function runValidateRecipes(args: string[]) {
  const tsxBin = process.platform === "win32" ? "tsx.cmd" : "tsx";
  return spawnSync(
    join(process.cwd(), "node_modules", ".bin", tsxBin),
    ["scripts/validate-recipes.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("validate-recipes script", () => {
  it("validates an explicit recipe file path instead of only the repo recipe corpus", () => {
    const dir = makeTempRoot();
    const recipePath = join(dir, "external_recipe.json");
    writeFileSync(
      recipePath,
      JSON.stringify(
        {
          id: "external_recipe",
          name: "External Recipe",
          nodes: [{ name: "noise1", type: "noiseTOP" }],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = runValidateRecipes([recipePath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("external_recipe.json");
    expect(result.stdout).toContain("1/1 recipes valid.");
    expect(result.stdout).not.toContain("audio_reactive_basic.json");
  });

  it("fails when an explicit recipe directory contains no recipes", () => {
    const dir = makeTempRoot();

    const result = runValidateRecipes([dir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No recipe files found.");
  });
});
