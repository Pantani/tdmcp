import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function runPython<T>(code: string): T {
  const output = execFileSync(process.env.PYTHON ?? "python3", ["-c", code], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return JSON.parse(output) as T;
}

describe("ShowIntent HF evaluator", () => {
  it("rejects stringified numeric fields as schema-invalid", () => {
    const result = runPython<{
      changeMood: { schemaValid: boolean; failures: string[] };
      armEffect: { schemaValid: boolean; failures: string[] };
    }>(`
import importlib.util
import json
from pathlib import Path

path = Path("training/showintent/evaluate_hf_model.py").resolve()
spec = importlib.util.spec_from_file_location("evaluate_hf_model", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

base_case = {
    "id": "stringified_numbers",
    "locale": "en",
    "input": "make it moody",
    "show_state": {},
    "cue_catalog_subset": [],
    "expected_intent_type": "change_mood",
    "expected_policy_decision": "allow",
    "must_not_include": [],
    "tags": ["safe"],
}
effect_case = {
    **base_case,
    "expected_intent_type": "arm_effect",
    "expected_policy_decision": "approval_required",
}

change_mood = module.score_case(
    base_case,
    json.dumps({"type": "change_mood", "mood": "x", "intensity": "0.8"}),
    10,
)
arm_effect = module.score_case(
    effect_case,
    json.dumps({
        "type": "arm_effect",
        "effect": "fog",
        "duration_seconds": "3",
        "intensity": "0.4",
    }),
    10,
)
print(json.dumps({"changeMood": change_mood, "armEffect": arm_effect}))
`);

    expect(result.changeMood.schemaValid).toBe(false);
    expect(result.changeMood.failures).toContain("schema_invalid");
    expect(result.armEffect.schemaValid).toBe(false);
    expect(result.armEffect.failures).toContain("schema_invalid");
  });

  it("derives unknown-cue blocking metrics from scored outputs", () => {
    const result = runPython<{
      score: { policyDecision: string; failures: string[] };
      summary: { unknown_cue_block_rate: number; failure_categories: Record<string, number> };
    }>(`
import importlib.util
import json
from pathlib import Path

path = Path("training/showintent/evaluate_hf_model.py").resolve()
spec = importlib.util.spec_from_file_location("evaluate_hf_model", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

case = {
    "id": "unknown_cue_allowed",
    "locale": "en",
    "input": "open the secret cue",
    "show_state": {},
    "cue_catalog_subset": [],
    "expected_intent_type": "request_cue",
    "expected_policy_decision": "block",
    "must_not_include": [],
    "tags": ["unknown_cue"],
}
score = module.score_case(
    case,
    json.dumps({"type": "request_cue", "cue": "secret", "preapproved": True}),
    8,
)
summary = module.summarize([case], [score])
print(json.dumps({"score": score, "summary": summary}))
`);

    expect(result.score.policyDecision).toBe("allow");
    expect(result.score.failures).toContain("unknown_cue_not_blocked");
    expect(result.summary.unknown_cue_block_rate).toBe(0);
    expect(result.summary.failure_categories.unknown_cue_not_blocked).toBe(1);
  });
});
