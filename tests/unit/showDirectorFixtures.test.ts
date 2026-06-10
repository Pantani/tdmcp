import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SetlistSchema } from "../../src/automation/setlistSchema.js";
import {
  EffectPolicySchema,
  evaluateShowIntent,
  ShowIntentSchema,
} from "../../src/automation/showDirectorSchema.js";

const fixtureUrl = (name: string) => new URL(`../fixtures/show-director/${name}`, import.meta.url);

function readJsonFixture(name: string): unknown {
  return JSON.parse(readFileSync(fixtureUrl(name), "utf8"));
}

function readJsonlFixture(name: string): Array<Record<string, unknown>> {
  return readFileSync(fixtureUrl(name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("AI-Controlled Party producer POC fixtures", () => {
  it("keeps the producer setlist fixture aligned with the setlist schema", () => {
    const setlist = SetlistSchema.parse(readJsonFixture("producer-demo-setlist.json"));

    expect(setlist.title).toBe("AI-Controlled Party Producer POC");
    expect(setlist.scenes).toHaveLength(7);
    expect(setlist.scenes?.map((scene) => scene.id)).toContain("safety_proof");
  });

  it("keeps the producer effect policy fixture aligned with the policy schema", () => {
    const policy = EffectPolicySchema.parse(readJsonFixture("producer-demo-policy.json"));

    expect(policy.effects).toHaveLength(10);
    expect(policy.effects.find((entry) => entry.effect === "fog")?.decision).toBe(
      "require_approval",
    );
    expect(policy.effects.find((entry) => entry.effect === "laser")?.operator_only).toBe(true);
  });

  it("keeps the producer intent fixture decisions aligned with the policy runtime", () => {
    const policy = EffectPolicySchema.parse(readJsonFixture("producer-demo-policy.json"));
    const rows = readJsonlFixture("producer-demo-intents.jsonl");

    expect(rows).toHaveLength(10);
    for (const row of rows) {
      const intent = ShowIntentSchema.parse(row.intent);
      const decision = evaluateShowIntent(intent, policy);
      expect(decision.decision, String(row.label)).toBe(row.expected_decision);
    }
  });
});
