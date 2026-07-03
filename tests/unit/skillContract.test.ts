import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSkillContract, writeSkillContract } from "../../src/cli/skillContract.js";

const tempDirs: string[] = [];
afterEach(() => Promise.all(tempDirs.splice(0).map((d) => rm(d, { force: true, recursive: true }))));

describe("skill contract", () => {
  it("describes every tool with a name and JSON-Schema input", async () => {
    const contract = await buildSkillContract();
    expect(contract.name).toBe("tdmcp");
    expect(contract.toolCount).toBeGreaterThanOrEqual(31);
    expect(contract.tools.length).toBe(contract.toolCount);
    const info = contract.tools.find((t) => t.name === "get_td_info");
    expect(info).toBeDefined();
    expect(info?.inputSchema).toBeTypeOf("object");
    // Sorted by name for stable diffs across releases.
    const names = contract.tools.map((t) => t.name);
    expect([...names].sort()).toEqual(names);
  });

  it("writes a pretty JSON file that round-trips", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tdmcp-contract-"));
    tempDirs.push(dir);
    const out = join(dir, "nested", "skill-contract.json");
    const contract = await writeSkillContract(out);
    const parsed = JSON.parse(await readFile(out, "utf8"));
    expect(parsed.toolCount).toBe(contract.toolCount);
    expect(parsed.tools[0]).toHaveProperty("inputSchema");
  });
});
