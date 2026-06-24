#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ledgerPath = fileURLToPath(new URL("./ledger.json", import.meta.url));

const seed = {
  campaign: "bottobot_followup",
  source: {
    upstreamRepo: "https://github.com/bottobot/touchdesigner-mcp-server",
    baselinePr: 111,
    baselineMergeCommit: "208b9bb0b210e9809a5c72375c47a7637f1d75ec",
  },
  policy: {
    branch: "Pantani/cx/bottobot-followup-waves",
    scope: "staged-by-small-wave",
    release: "commit-and-push-NO-tag",
    builderRetry: 1,
    onRepeatFail: "quarantine-and-continue",
    tdLiveChecks: "UNVERIFIED-pending-td unless bridge is reachable",
  },
  features: [
    {
      id: "tutorial_to_recipe",
      wave: 1,
      priority: "P0",
      status: "pending",
      surface: "layer3",
      value: "Draft a RecipeSchema-valid recipe from Bottobot-derived tutorial content by extracting and validating a conservative operator chain.",
      dependsOn: ["get_tutorial", "draft_recipe_from_operator_chain"],
      files: [],
      qa: [],
      history: [],
    },
    {
      id: "tutorial_structured_content_hardening",
      wave: 1,
      priority: "P0",
      status: "pending",
      surface: "knowledge/layer3",
      value: "Flatten structured tutorial sections/code/list items to searchable text so get_tutorial and tutorial_to_recipe do not leak object-shaped content.",
      dependsOn: ["get_tutorial"],
      files: [],
      qa: [],
      history: [],
    },
    {
      id: "bottobot_knowledge_cookbook_examples",
      wave: 2,
      priority: "P1",
      status: "pending",
      surface: "docs",
      value: "Add real EN/PT cookbook examples that demonstrate the shipped knowledge tools and the tutorial-to-recipe path without duplicating generated references.",
      dependsOn: ["tutorial_to_recipe"],
      files: [],
      qa: [],
      history: [],
    },
    {
      id: "network_template_gap_review",
      wave: 3,
      priority: "P2",
      status: "quarantined-no-new-feature",
      surface: "layer3/docs",
      value: "Decide whether Bottobot get_network_template adds non-duplicative value beyond suggest_operator_chain, validate_operator_chain, draft_recipe_from_operator_chain and existing first-party recipes.",
      dependsOn: ["tutorial_to_recipe"],
      files: [
        "_workspace/campaign_bottobot_followup/wave_3_network_template_gap_review.md",
        "_workspace/campaign_bottobot_followup/ledger.json",
        "_workspace/campaign_bottobot_followup/build-ledger.mjs",
      ],
      qa: [
        "PASS: read-only Bottobot source audit of tools/get_network_template.js confirmed a static Markdown catalog with five templates and no RecipeSchema validation or TD application.",
        "PASS: subagent review confirmed Bottobot get_network_template data is the in-module hard-coded TEMPLATES object, not imported patterns/operator/tutorial knowledge data.",
        "PASS: current tdmcp surface audit confirmed overlapping validated recipes, Layer 1 builders, suggest_operator_chain, validate_operator_chain, draft_recipe_from_operator_chain, and draft_recipe_from_tutorial.",
      ],
      history: [
        "Quarantined get_network_template as duplicate of stronger tdmcp recipe/builder/chain surfaces.",
        "No new tool, registry, CLI, or generated docs change is warranted unless a future source provides materially new validated template assets.",
        "Live TouchDesigner execution not attempted; status remains UNVERIFIED-pending-td.",
      ],
    },
  ],
  shippedBaseline: [
    "bottobot_knowledge_resources",
    "search_touchdesigner_knowledge",
    "get_operator_workflow_guide",
    "compare_operator_docs",
    "search_python_api",
    "suggest_operator_chain",
    "plan_td_version_migration",
    "validate_operator_chain",
    "draft_recipe_from_operator_chain",
    "get_technique_detail",
    "draft_recipe_from_technique",
    "get_tutorial",
    "techniques_cli_aliases",
    "tutorials_cli_aliases",
  ],
};

let current = {};
try {
  current = JSON.parse(readFileSync(ledgerPath, "utf8"));
} catch {
  current = {};
}

const currentById = new Map((current.features ?? []).map((feature) => [feature.id, feature]));
const features = seed.features.map((feature) => ({
  ...feature,
  ...(currentById.get(feature.id) ?? {}),
}));

const ledger = {
  ...seed,
  ...current,
  policy: { ...seed.policy, ...(current.policy ?? {}) },
  source: { ...seed.source, ...(current.source ?? {}) },
  shippedBaseline: seed.shippedBaseline,
  features,
  updatedAt: new Date().toISOString(),
};

writeFileSync(`${ledgerPath}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`);
writeFileSync(ledgerPath, readFileSync(`${ledgerPath}.tmp`, "utf8"));
