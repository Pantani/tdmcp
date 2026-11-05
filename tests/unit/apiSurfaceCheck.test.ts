import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// End-to-end through the real CLI against a miniature project, so extraction,
// baseline, acknowledgements and exit codes are tested together.
const REPO = process.cwd();

let root: string;

function writeRegistry(fields: string, extraImports = ""): void {
  writeFileSync(
    join(root, "src/tools/index.ts"),
    `import { z } from "zod";
${extraImports}
export function registerAllTools(server: any) {
  server.registerTool("demo", {
    description: "A demo tool.",
    inputSchema: { ${fields} },
  }, () => {});
}
`,
  );
}

function writeContext(body: string): void {
  writeFileSync(join(root, "src/tools/types.ts"), `export interface ToolContext { ${body} }\n`);
}

function writeVersion(version: string): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version }));
}

function run(...args: string[]) {
  const result = spawnSync(
    join(REPO, "node_modules/.bin/tsx"),
    [join(REPO, "scripts/api-surface/check.ts"), "--root", root, ...args],
    { cwd: root, encoding: "utf8" },
  );
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

const acksPath = () => join(root, "api-surface/acknowledged-breaks.json");
const baselinePath = () => join(root, "api-surface/baseline.json");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const firstBreakId = (output: string) => output.match(/id: (\S+)/)?.[1] as string;

function acknowledge(id: string, reason = "agreed with the maintainer in review"): void {
  const acks = readJson(acksPath());
  acks.acknowledged.push({ id, reason });
  writeFileSync(acksPath(), JSON.stringify(acks));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tdmcp-api-surface-")));
  mkdirSync(join(root, "src/tools"), { recursive: true });
  mkdirSync(join(root, "api-surface"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  writeVersion("1.0.0");
  writeContext("logger: unknown; vault?: string;");
  writeRegistry(`name: z.string(), limit: z.number().max(100).default(10)`);
  expect(run("--update-baseline").code).toBe(0);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("api-surface check", () => {
  it("writes a baseline without documentation in it", () => {
    writeRegistry(`description: z.string().describe("A field named description")`);
    rmSync(baselinePath());
    expect(run("--update-baseline").code).toBe(0);
    const baseline = readJson(baselinePath());
    expect(baseline.version).toBe("1.0.0");
    expect(baseline.tools.demo.schema.properties.description).toEqual({ type: "string" });
    expect(baseline.toolContext.fields.logger).toEqual({ optional: false, type: "unknown" });
    expect(baseline.toolContext.fields.vault).toEqual({ optional: true, type: "string" });
  });

  it("passes on an unchanged tree", () => {
    const { code, output } = run();
    expect(output).toContain("compatible with the 1.0.0 baseline");
    expect(code).toBe(0);
  });

  it("passes on an additive change without touching the baseline", () => {
    const before = readFileSync(baselinePath(), "utf8");
    writeRegistry(
      `name: z.string().describe("reworded"), limit: z.number().max(200).default(10), extra: z.string().optional()`,
    );
    writeContext("logger: unknown; vault?: string; added?: number;");
    const { code, output } = run();
    expect(output).toContain("ToolContext optional field added: added");
    expect(code).toBe(0);
    expect(readFileSync(baselinePath(), "utf8")).toBe(before);
  });

  it("ignores reformatting of a ToolContext type", () => {
    writeContext("logger:\n  unknown;\n  /** docs */\n  vault?:   string;");
    expect(run().code).toBe(0);
  });

  it("fails on a tightened field and names it", () => {
    writeRegistry(`name: z.string().max(8), limit: z.number().max(100).default(10)`);
    const { code, output } = run();
    expect(code).toBe(1);
    expect(output).toContain("demo.name bound-tightened:maxLength");
    expect(output).toContain("id: tool:demo|.name|bound-tightened:maxLength|");
  });

  it("fails on a ToolContext break", () => {
    writeContext("vault?: string;");
    const { code, output } = run();
    expect(code).toBe(1);
    expect(output).toContain("ToolContext.logger field-removed");
  });

  it("sees a superRefine and a shared schema on every field that uses it", () => {
    writeRegistry(
      `name: shared, other: shared, limit: z.number().max(100).default(10)`,
      `const shared = z.string().superRefine((value, ctx) => {
         if (value === "x") ctx.addIssue({ code: "custom", message: "no" });
       });`,
    );
    const { code, output } = run();
    expect(code).toBe(1);
    expect(output).toContain("demo.name refinement-added");
    expect(output).not.toContain("demo.other refinement-added");

    writeFileSync(acksPath(), JSON.stringify({ acknowledged: [], history: [] }));
    rmSync(baselinePath());
    writeRegistry(`name: z.string(), other: z.string()`);
    expect(run("--update-baseline").code).toBe(0);
    writeRegistry(
      `name: shared, other: shared`,
      `const shared = z.string().refine((value) => value !== "x");`,
    );
    const shared = run();
    expect(shared.output).toContain("demo.name refinement-added");
    expect(shared.output).toContain("demo.other refinement-added");
  });

  it("does not depend on the environment of whoever runs it", () => {
    const result = spawnSync(
      join(REPO, "node_modules/.bin/tsx"),
      [join(REPO, "scripts/api-surface/check.ts"), "--root", root],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, TDMCP_RAW_PYTHON: "off", TDMCP_TOOL_PROFILE: "safe" },
      },
    );
    expect(result.status).toBe(0);
  });

  describe("acknowledgements", () => {
    beforeEach(() => {
      writeRegistry(`name: z.string().max(8), limit: z.number().max(100).default(10)`);
    });

    it("passes once the exact break is acknowledged, and says so", () => {
      acknowledge(firstBreakId(run().output));
      const { code, output } = run();
      expect(code).toBe(0);
      expect(output).toContain("acknowledged break: tool:demo|.name|");
      expect(output).toContain("agreed with the maintainer in review");
    });

    it("does not carry over to a further tightening", () => {
      acknowledge(firstBreakId(run().output));
      writeRegistry(`name: z.string().max(4), limit: z.number().max(100).default(10)`);
      const { code, output } = run();
      expect(code).toBe(1);
      expect(output).toContain("Stale acknowledgements (1)");
    });

    it("rejects an acknowledgement without a real reason", () => {
      acknowledge(firstBreakId(run().output), "  ok  ");
      const { code, output } = run();
      expect(code).toBe(2);
      expect(output).toContain('a "reason" of at least 10 characters');
    });

    it("fails on an acknowledgement left behind after the break is reverted", () => {
      acknowledge(firstBreakId(run().output));
      writeRegistry(`name: z.string(), limit: z.number().max(100).default(10)`);
      const { code, output } = run();
      expect(code).toBe(1);
      expect(output).toContain("Stale acknowledgements (1)");
    });
  });

  describe("baseline updates", () => {
    it("refuses to bless an unacknowledged break", () => {
      const before = readFileSync(baselinePath(), "utf8");
      writeRegistry(`name: z.string().max(8), limit: z.number().max(100).default(10)`);
      const { code, output } = run("--update-baseline");
      expect(code).toBe(1);
      expect(output).toContain("Breaking changes to the pinned tool API");
      expect(readFileSync(baselinePath(), "utf8")).toBe(before);
    });

    it("moves acknowledged breaks to history when the baseline moves", () => {
      writeRegistry(`name: z.string().max(8), limit: z.number().max(100).default(10)`);
      const id = firstBreakId(run().output);
      acknowledge(id);
      writeVersion("2.0.0");
      expect(run("--update-baseline").code).toBe(0);
      expect(readJson(baselinePath()).version).toBe("2.0.0");
      expect(readJson(acksPath())).toEqual({
        acknowledged: [],
        history: [
          { id, reason: "agreed with the maintainer in review", acceptedInBaseline: "2.0.0" },
        ],
      });
      expect(run().code).toBe(0);
    });

    it("fails a version bump that did not refresh the baseline", () => {
      writeVersion("1.0.1");
      const { code, output } = run();
      expect(code).toBe(1);
      expect(output).toContain("The baseline pins 1.0.0 but package.json is 1.0.1");
      expect(run("--update-baseline").code).toBe(0);
      expect(run().code).toBe(0);
    });
  });

  it("cannot run without a baseline, and says how to create one", () => {
    rmSync(baselinePath());
    const { code, output } = run();
    expect(code).toBe(2);
    expect(output).toContain("npm run api:update");
    expect(existsSync(baselinePath())).toBe(false);
  });

  it("fails loudly when ToolContext stops being an interface", () => {
    writeFileSync(join(root, "src/tools/types.ts"), "export type ToolContext = { a: string };\n");
    const { code, output } = run();
    expect(code).toBe(2);
    expect(output).toContain("no longer declares `interface ToolContext`");
  });
});
