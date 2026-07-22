import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTdmcpStdioServer,
  manageClientRegistration,
  renderClientRegistrationSnippet,
  resolveClientRegistrationTarget,
} from "../../src/cli/clientRegistration.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tdmcp-client-registration-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const server = buildTdmcpStdioServer({ host: "127.0.0.1", port: 9982, token: "secret" });

describe("client registration targets", () => {
  it("resolves native Claude, Cursor, and Codex paths", async () => {
    const root = await tempRoot();
    await expect(
      resolveClientRegistrationTarget({ client: "claude", scope: "project", projectDir: root }),
    ).resolves.toMatchObject({ path: join(root, ".mcp.json"), format: "json" });
    await expect(
      resolveClientRegistrationTarget({ client: "cursor", scope: "project", projectDir: root }),
    ).resolves.toMatchObject({ path: join(root, ".cursor", "mcp.json") });
    await expect(
      resolveClientRegistrationTarget({ client: "codex", scope: "user", homeDir: root }),
    ).resolves.toMatchObject({ path: join(root, ".codex", "config.toml"), format: "toml" });
  });

  it("fails closed for unverified Codex project scope and unsafe names", async () => {
    const root = await tempRoot();
    await expect(
      resolveClientRegistrationTarget({ client: "codex", scope: "project", projectDir: root }),
    ).rejects.toThrow("not supported");
    await expect(
      resolveClientRegistrationTarget({ client: "claude", homeDir: root, name: "bad.name" }),
    ).rejects.toThrow("letters, digits");
    await expect(
      resolveClientRegistrationTarget({
        client: "claude",
        scope: "project",
        projectDir: "..",
        cwd: root,
      }),
    ).rejects.toThrow("parent traversal");
  });
});

describe("manageClientRegistration", () => {
  it("plans and atomically installs JSON while preserving unrelated entries", async () => {
    const root = await tempRoot();
    const path = join(root, ".mcp.json");
    await writeFile(
      path,
      JSON.stringify({ mcpServers: { other: { command: "other" } }, theme: "dark" }),
    );
    const plan = await manageClientRegistration({
      client: "claude",
      scope: "project",
      projectDir: root,
      action: "install",
      server,
    });
    expect(plan).toMatchObject({ state: "planned", changed: true, wrote: false });
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("mcpServers.tdmcp");

    const applied = await manageClientRegistration({
      client: "claude",
      scope: "project",
      projectDir: root,
      action: "install",
      server,
      write: true,
    });
    expect(applied).toMatchObject({ state: "applied", wrote: true, token_presence: "present" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      theme: "dark",
      mcpServers: { other: { command: "other" }, tdmcp: { command: "tdmcp" } },
    });
    expect(JSON.stringify(applied)).not.toContain("secret");
  });

  it("checks drift and removes only the named JSON entry", async () => {
    const root = await tempRoot();
    const common = {
      client: "cursor" as const,
      scope: "project" as const,
      projectDir: root,
      server,
    };
    await manageClientRegistration({ ...common, action: "install", write: true });
    await expect(manageClientRegistration({ ...common, action: "check" })).resolves.toMatchObject({
      state: "matching",
      wrote: false,
    });
    const path = join(root, ".cursor", "mcp.json");
    const parsed = JSON.parse(await readFile(path, "utf8"));
    parsed.mcpServers.tdmcp.command = "old";
    parsed.mcpServers.other = { command: "keep" };
    await writeFile(path, JSON.stringify(parsed));
    await expect(manageClientRegistration({ ...common, action: "check" })).resolves.toMatchObject({
      state: "drifted",
      fields_changed: expect.arrayContaining(["command"]),
    });
    await manageClientRegistration({ ...common, action: "remove", write: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      mcpServers: { other: { command: "keep" } },
    });
  });

  it("installs and removes one Codex TOML section", async () => {
    const root = await tempRoot();
    const path = join(root, ".codex", "config.toml");
    await mkdir(join(root, ".codex"));
    await writeFile(path, 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "other"\n');
    const common = { client: "codex" as const, scope: "user" as const, homeDir: root, server };
    await manageClientRegistration({ ...common, action: "install", write: true });
    const installed = await readFile(path, "utf8");
    expect(installed).toContain("[mcp_servers.tdmcp]");
    expect(installed).toContain("[mcp_servers.other]");
    await expect(manageClientRegistration({ ...common, action: "check" })).resolves.toMatchObject({
      state: "matching",
    });
    await manageClientRegistration({ ...common, action: "remove", write: true });
    const removed = await readFile(path, "utf8");
    expect(removed).not.toContain("mcp_servers.tdmcp");
    expect(removed).toContain("mcp_servers.other");
  });

  it("rejects malformed and symlinked configs without replacing them", async () => {
    const root = await tempRoot();
    const malformed = join(root, "malformed.json");
    await writeFile(malformed, "{bad");
    await expect(
      manageClientRegistration({
        client: "claude",
        explicitPath: malformed,
        action: "install",
        server,
        write: true,
      }),
    ).rejects.toThrow("Invalid JSON");
    expect(await readFile(malformed, "utf8")).toBe("{bad");

    const real = join(root, "real.json");
    const link = join(root, "link.json");
    await writeFile(real, "{}");
    await symlink(real, link);
    await expect(
      manageClientRegistration({
        client: "claude",
        explicitPath: link,
        action: "install",
        server,
      }),
    ).rejects.toThrow("symbolic link");
  });

  it("fails without overwriting a concurrent config change", async () => {
    const root = await tempRoot();
    const path = join(root, ".mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: {}, owner: "initial" }));
    const concurrent = `${JSON.stringify({ mcpServers: {}, owner: "another-process" })}\n`;

    await expect(
      manageClientRegistration(
        {
          client: "claude",
          scope: "project",
          projectDir: root,
          action: "install",
          server,
          write: true,
        },
        { beforeWrite: () => writeFile(path, concurrent) },
      ),
    ).rejects.toThrow("changed while the update was being prepared");
    expect(await readFile(path, "utf8")).toBe(concurrent);
  });

  it("renders snippets without changing the existing legacy shape", () => {
    const noToken = buildTdmcpStdioServer({ host: "127.0.0.1", port: 9980 });
    expect(renderClientRegistrationSnippet("claude", "tdmcp", noToken)).toEqual({
      mcpServers: { tdmcp: noToken },
    });
    expect(renderClientRegistrationSnippet("codex", "tdmcp", noToken)).toContain(
      "[mcp_servers.tdmcp]",
    );
  });
});
