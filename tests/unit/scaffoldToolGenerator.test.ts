import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  scaffoldToolGeneratorImpl,
  scaffoldToolGeneratorSchema,
} from "../../src/tools/layer2/scaffoldToolGenerator.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const ctx = { logger: silentLogger } as unknown as ToolContext;

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "scaffold-tool-gen-test-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function base(over: Record<string, unknown> = {}) {
  return scaffoldToolGeneratorSchema.parse({
    name: "create_foo",
    layer: "layer2",
    surface: "bridge",
    description: "Make a foo.",
    repo_root: tmp,
    ...over,
  });
}

describe("scaffoldToolGenerator", () => {
  it("renders a Layer-2 bridge tool — files exist and have expected content", async () => {
    const result = await scaffoldToolGeneratorImpl(ctx, base());
    expect(result.isError).toBeFalsy();

    const toolPath = path.join(tmp, "src", "tools", "layer2", "createFoo.ts");
    const testPath = path.join(tmp, "tests", "unit", "createFoo.test.ts");

    const toolSrc = await fs.readFile(toolPath, "utf8");
    const testSrc = await fs.readFile(testPath, "utf8");

    expect(toolSrc).toContain("createFooSchema");
    expect(toolSrc).toContain("createFooImpl");
    expect(toolSrc).toContain("registerCreateFoo");
    expect(toolSrc).toContain("buildPayloadScript");
    expect(toolSrc).toContain("parsePythonReport");
    expect(toolSrc).toContain('"create_foo"');

    expect(testSrc).toContain("createFooImpl");
    expect(testSrc).toContain("createFooSchema");
  });

  it("integration hint has correct shape", async () => {
    const result = await scaffoldToolGeneratorImpl(ctx, base());
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      integration_hint: {
        registrar_import: string;
        registrar_array_entry: string;
        layer_index_path: string;
        cli_command_name: string;
      };
    };
    expect(sc.integration_hint.registrar_import).toContain("registerCreateFoo");
    expect(sc.integration_hint.registrar_import).toContain("createFoo.js");
    expect(sc.integration_hint.registrar_array_entry).toBe("registerCreateFoo,");
    expect(sc.integration_hint.layer_index_path).toBe("src/tools/layer2/index.ts");
    expect(sc.integration_hint.cli_command_name).toBe("create-foo");
  });

  it("renders a Layer-1 build tool", async () => {
    const result = await scaffoldToolGeneratorImpl(
      ctx,
      base({ layer: "layer1", surface: "layer1_build" }),
    );
    expect(result.isError).toBeFalsy();
    const toolPath = path.join(tmp, "src", "tools", "layer1", "createFoo.ts");
    const src = await fs.readFile(toolPath, "utf8");
    expect(src).toContain("orchestration.js");
    expect(src).toContain("runBuild");
    expect(src).toContain("createSystemContainer");
    expect(src).toContain("finalize");
  });

  it("renders prompt surface at src/prompts/", async () => {
    const result = await scaffoldToolGeneratorImpl(ctx, base({ surface: "prompt" }));
    expect(result.isError).toBeFalsy();
    const promptPath = path.join(tmp, "src", "prompts", "createFoo.ts");
    const src = await fs.readFile(promptPath, "utf8");
    expect(src).toContain("description");
    expect(src).toContain("register");
  });

  it("name-collision refuses without overwrite", async () => {
    // First call creates the file
    await scaffoldToolGeneratorImpl(ctx, base());
    // Second call without overwrite should refuse
    const result = await scaffoldToolGeneratorImpl(ctx, base());
    expect(result.isError).toBe(true);
    const text = result.content[0];
    if (text?.type === "text") {
      expect(text.text).toContain("File exists");
    }
  });

  it("name-collision with overwrite=true succeeds", async () => {
    await scaffoldToolGeneratorImpl(ctx, base());
    const result = await scaffoldToolGeneratorImpl(ctx, base({ overwrite: true }));
    expect(result.isError).toBeFalsy();
  });

  it("surface/layer mismatch returns isError without throwing", async () => {
    const args = base({ layer: "layer2", surface: "layer1_build" });
    await expect(scaffoldToolGeneratorImpl(ctx, args)).resolves.toMatchObject({ isError: true });
    const result = await scaffoldToolGeneratorImpl(ctx, args);
    const text = result.content[0];
    if (text?.type === "text") {
      expect(text.text).toContain("layer1_build surface requires layer='layer1'");
    }
  });

  it("schema rejects non-snake_case name", () => {
    expect(() =>
      scaffoldToolGeneratorSchema.parse({
        name: "Create-Foo",
        description: "x",
      }),
    ).toThrow();
  });

  it("schema rejects reserved name at impl level", async () => {
    const args = base({ name: "get_td_info" });
    const result = await scaffoldToolGeneratorImpl(ctx, args);
    expect(result.isError).toBe(true);
  });
});
