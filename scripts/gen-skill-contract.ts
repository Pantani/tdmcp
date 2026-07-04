/**
 * Export tdmcp's portable "skill contract" — a host-agnostic JSON snapshot of every
 * tool (name, description, JSON-Schema inputs) + prompts.
 *
 *   npm run contract:gen            # writes skill-contract.json at the repo root
 *   npm run contract:gen -- path.json
 *
 * Another agent framework can consume this to embed tdmcp's capabilities without
 * booting the server; it also diffs cleanly across releases to catch surface drift.
 */
import { writeSkillContract } from "../src/cli/skillContract.js";

const outPath = process.argv[2] ?? "skill-contract.json";

writeSkillContract(outPath)
  .then((contract) => {
    console.log(
      `[contract] wrote ${outPath} — ${contract.toolCount} tools, ${contract.promptCount} prompts (tdmcp ${contract.version}).`,
    );
  })
  .catch((err) => {
    console.error("[contract] FAILED:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
