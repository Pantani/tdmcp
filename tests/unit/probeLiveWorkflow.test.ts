import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

interface WorkflowStep {
  uses?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  on?: {
    pull_request?: unknown;
    push?: { branches?: string[] };
    workflow_dispatch?: unknown;
  };
  jobs?: {
    probe?: {
      permissions?: Record<string, string>;
      "timeout-minutes"?: number;
      steps?: WorkflowStep[];
    };
  };
}

function readWorkflow(name: string): { raw: string; parsed: Workflow } {
  const raw = readFileSync(resolve(process.cwd(), ".github", "workflows", name), "utf8");
  return { raw, parsed: parseYaml(raw) as Workflow };
}

describe("probe-live workflow trust boundary", () => {
  it("keeps the pull-request workflow completely free of repository secrets", () => {
    const { raw, parsed } = readWorkflow("probe-live.yml");

    expect(parsed.on?.pull_request).toBeDefined();
    expect(parsed.on?.push).toBeUndefined();
    expect(parsed.on?.workflow_dispatch).toBeUndefined();
    expect(raw).not.toContain("secrets.");
    expect(raw).toContain("Probe changed public sources (no secrets)");
    expect(raw).not.toContain("Probe changed sources with trusted credentials");
  });

  it("runs credentialed probes only from main with a minimal bounded job", () => {
    const { raw, parsed } = readWorkflow("probe-live-trusted.yml");
    const job = parsed.jobs?.probe;

    expect(parsed.on?.pull_request).toBeUndefined();
    expect(parsed.on?.workflow_dispatch).toBeUndefined();
    expect(parsed.on?.push?.branches).toEqual(["main"]);
    expect(job?.permissions).toEqual({ contents: "read" });
    expect(job?.["timeout-minutes"]).toBe(15);
    expect(raw).toContain("secrets.TDMCP_RAG_EUROPEANA_KEY");

    const checkout = job?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout).toBeDefined();
    expect(checkout?.with?.ref).toBeUndefined();
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });
});
