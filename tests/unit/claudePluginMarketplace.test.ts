import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("Claude Code plugin marketplace", () => {
  it("publishes the tdmcp plugin from the marketplace catalog", () => {
    const marketplace = JSON.parse(
      readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as {
      name?: string;
      owner?: { name?: string };
      plugins?: Array<{ name?: string; source?: string; description?: string }>;
    };

    expect(marketplace).toMatchObject({
      name: "tdmcp",
      owner: { name: "Pantani" },
    });
    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        name: "tdmcp",
        source: "./plugins/tdmcp",
        description: expect.any(String),
      }),
    );
  });
});
