import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
}

interface WorkflowJob {
  if?: string;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: {
    validate?: WorkflowJob;
    "github-release"?: WorkflowJob;
    "npm-publish"?: WorkflowJob;
  };
}

const root = process.cwd();
const workflowRaw = readFileSync(resolve(root, ".github", "workflows", "release.yml"), "utf8");
const workflow = parseYaml(workflowRaw) as Workflow;
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

function stepNamed(job: WorkflowJob | undefined, name: string): WorkflowStep | undefined {
  return job?.steps?.find((step) => step.name === name);
}

function githubExpression(expression: string): string {
  return `\${{ ${expression} }}`;
}

describe("release workflow trust boundaries", () => {
  it("gives gh an explicit repository outside a checkout", () => {
    const job = workflow.jobs?.["github-release"];
    const publish = stepNamed(job, "Publish GitHub Release");

    expect(job?.steps?.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(publish?.env?.GH_REPO).toBe(githubExpression("github.repository"));
    expect(publish?.run).toContain("gh release view");
    expect(publish?.run).toContain("gh release upload");
    expect(publish?.run).toContain("gh release create");
  });

  it("does not start or materialize npm credentials when auto-publish is disabled", () => {
    const job = workflow.jobs?.["npm-publish"];
    const publish = stepNamed(job, "Publish to npm");

    expect(job?.if).toBe("vars.TDMCP_AUTO_NPM_PUBLISH == 'true'");
    expect(job?.steps).toHaveLength(3);
    expect(publish?.env).toEqual({ NODE_AUTH_TOKEN: githubExpression("secrets.NPM_TOKEN") });
    expect(publish?.run).toContain('if [ -z "$NODE_AUTH_TOKEN" ]');
    expect(publish?.run).toContain("exit 1");

    for (const step of job?.steps ?? []) {
      if (step === publish) continue;
      expect(JSON.stringify(step)).not.toContain("secrets.NPM_TOKEN");
    }
  });

  it("shares one complete non-publishing release check with prepublishOnly", () => {
    const releaseCheck = packageJson.scripts["release:check"];
    const validate = stepNamed(workflow.jobs?.validate, "Run non-publishing release checks");

    expect(validate?.run).toBe("npm run release:check");
    expect(packageJson.scripts.prepublishOnly).toBe("npm run release:check");
    for (const required of [
      "npm run typecheck",
      "npm run lint",
      "npm run validate:recipes",
      "npm run lint:recipes",
      "npm test",
      "npm run test:bridge",
      "npm run build",
      "npm run build:mcpb",
    ]) {
      expect(releaseCheck).toContain(required);
    }
    expect(releaseCheck).not.toMatch(/(?:npm|pnpm)\s+(?:run\s+)?(?:release:check|prepublishOnly)/);
    expect(releaseCheck).not.toMatch(/(?:npm|pnpm)\s+(?:pack|publish)/);
  });
});
