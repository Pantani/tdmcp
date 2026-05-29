/**
 * Generates docs/reference/tools.md from the live tool registry so the docs site
 * can never drift from the real tools. Runs before every docs build.
 *
 *   npm run docs:gen
 *
 * It registers each layer's tools against a capturing stub (the registrars only
 * ever call `server.registerTool`), reads each tool's Zod input schema, and
 * renders a grouped Markdown reference. No TouchDesigner or network needed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { layer1Registrars } from "../src/tools/layer1/index.js";
import { layer2Registrars } from "../src/tools/layer2/index.js";
import { layer3Registrars } from "../src/tools/layer3/index.js";
import { libraryRegistrars } from "../src/tools/library/index.js";
import type { ToolContext, ToolRegistrar } from "../src/tools/types.js";
import { vaultRegistrars } from "../src/tools/vault/index.js";

interface RegisteredTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape;
  annotations?: Record<string, unknown>;
}

interface ToolGroup {
  id: string;
  heading: string;
  blurb: string;
  tools: RegisteredTool[];
}

/** Runs a layer's registrars against a stub that records the tool definitions. */
function capture(registrars: ToolRegistrar[]): RegisteredTool[] {
  const collected: RegisteredTool[] = [];
  const stub = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "registerTool") {
          return (
            name: string,
            config: {
              title?: string;
              description?: string;
              inputSchema?: z.ZodRawShape;
              annotations?: Record<string, unknown>;
            },
          ) => {
            collected.push({
              name,
              title: config.title,
              description: config.description,
              inputSchema: config.inputSchema,
              annotations: config.annotations,
            });
          };
        }
        // Any other server method a registrar might touch is a harmless no-op here.
        return () => {};
      },
    },
  ) as unknown as McpServer;
  // allowRawPython: true so the escape-hatch tools register; vault tools register
  // unconditionally. Registration never reads client/knowledge/recipes, so a bare
  // context is safe.
  const ctx = { allowRawPython: true } as unknown as ToolContext;
  for (const register of registrars) register(stub, ctx);
  return collected;
}

/** A short, human-readable type label for one JSON-schema property. */
function typeLabel(prop: Record<string, unknown>): string {
  if (Array.isArray(prop.enum)) {
    const values = prop.enum as unknown[];
    const shown = values.slice(0, 6).map((v) => `\`${String(v)}\``);
    if (values.length > 6) shown.push("…");
    return shown.join(" \\| ");
  }
  if (prop.const !== undefined) return `\`${String(prop.const)}\``;
  if (Array.isArray(prop.anyOf) || Array.isArray(prop.oneOf)) {
    const variants = (prop.anyOf ?? prop.oneOf) as Record<string, unknown>[];
    return [...new Set(variants.map((v) => typeLabel(v)))].join(" \\| ");
  }
  const t = prop.type;
  if (t === "array") {
    const items = (prop.items as Record<string, unknown>) ?? {};
    return `${typeLabel(items)}[]`;
  }
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.join(" \\| ");
  return "object";
}

/**
 * Collapse whitespace so a description fits in one Markdown table cell, and
 * escape characters that VitePress's Vue compiler would otherwise choke on:
 * raw `<…>` (e.g. `<path>`) is read as an HTML/Vue tag, and `|` breaks tables.
 */
function oneLine(text: string | undefined): string {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .trim();
}

function renderParams(tool: RegisteredTool): string {
  const shape = tool.inputSchema;
  if (!shape || Object.keys(shape).length === 0) return "_No parameters._\n";

  let schema: Record<string, unknown>;
  try {
    schema = z.toJSONSchema(z.object(shape), { io: "input" }) as Record<string, unknown>;
  } catch {
    // Fallback: list parameter names with whatever description Zod carries.
    const rows = Object.entries(shape).map(([name, field]) => {
      const desc = oneLine((field as { description?: string }).description);
      return `| \`${name}\` | — | — | ${desc} |`;
    });
    return `| Parameter | Type | Required | Description |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n`;
  }

  const props = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
  const required = new Set((schema.required as string[]) ?? []);
  const rows = Object.entries(props).map(([name, prop]) => {
    const hasDefault = prop.default !== undefined;
    const req = required.has(name) && !hasDefault ? "yes" : "no";
    let desc = oneLine(prop.description as string | undefined);
    if (hasDefault) desc = `${desc ? `${desc} ` : ""}_(default: \`${String(prop.default)}\`)_`;
    return `| \`${name}\` | ${typeLabel(prop)} | ${req} | ${desc} |`;
  });
  return `| Parameter | Type | Required | Description |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n`;
}

function badges(tool: RegisteredTool): string {
  const a = tool.annotations ?? {};
  const parts: string[] = [];
  if (a.readOnlyHint === true) parts.push('<Badge type="tip" text="read-only" />');
  if (a.destructiveHint === true) parts.push('<Badge type="danger" text="destructive" />');
  else if (a.readOnlyHint === false) parts.push('<Badge type="warning" text="mutates" />');
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function renderGroup(group: ToolGroup): string {
  const lines: string[] = [`## ${group.heading}`, "", group.blurb, ""];
  for (const tool of group.tools) {
    lines.push(`### \`${tool.name}\`${badges(tool)}`, "");
    if (tool.description) lines.push(oneLine(tool.description), "");
    lines.push(renderParams(tool), "");
  }
  return lines.join("\n");
}

function main(): void {
  const groups: ToolGroup[] = [
    {
      id: "layer1",
      heading: "Artist tools (Layer 1)",
      blurb:
        "Describe the result you want; each tool builds and wires a whole network, auto-arranges it into a readable left→right layout, and — for the playable systems — exposes a control panel you can tweak, animate, preset or map to a controller.",
      tools: capture(layer1Registrars),
    },
    {
      id: "layer2",
      heading: "Building blocks & live control (Layer 2)",
      blurb:
        "Mid-level tools for assembling, wiring, controlling, animating and storing networks — the pieces the Layer 1 generators are built from, exposed for fine control.",
      tools: capture(layer2Registrars),
    },
    {
      id: "layer3",
      heading: "Nodes, inspection & debugging (Layer 3)",
      blurb:
        "Atomic node CRUD plus the inspection, analysis, rendering and escape-hatch tools. Read-only inspectors are safe to call freely; the Python escape hatches run code inside TouchDesigner.",
      tools: capture(layer3Registrars),
    },
    {
      id: "library",
      heading: "Library & packaging",
      blurb:
        "Local-first component, recipe and package tooling: browse libraries, inspect manifests, bundle/import recipes, package .tox components, refresh previews, and maintain a local marketplace index.",
      tools: capture(libraryRegistrars),
    },
    {
      id: "vault",
      heading: "Obsidian vault",
      blurb:
        "Bridge an Obsidian vault (set `TDMCP_VAULT_PATH`) and TouchDesigner: keep recipes, shaders, setlists, presets, moodboards and a dated show diary in Markdown and move them in and out of your project.",
      tools: capture(vaultRegistrars),
    },
  ];

  const total = groups.reduce((sum, g) => sum + g.tools.length, 0);
  const breakdown = groups.map((g) => `${g.tools.length} ${g.id}`).join(", ");

  const header = [
    "---",
    "title: Tools reference",
    `description: "Every tdmcp tool — the TouchDesigner MCP server exposes ${total} tools across three layers, library/packaging and an Obsidian vault, from one-line artist generators down to atomic node control."`,
    "---",
    "",
    "<!--",
    "  AUTO-GENERATED by scripts/gen-tool-docs.ts — do not edit by hand.",
    "  Regenerate with `npm run docs:gen` (runs automatically before `docs:build`).",
    "-->",
    "# Tools reference",
    "",
    `tdmcp exposes **${total} tools** organized into three layers, library/packaging, and the Obsidian vault integration. Build with the highest-level tool that fits and drop to a lower layer for fine control. Tools tagged <Badge type="tip" text="read-only" /> only inspect; <Badge type="warning" text="mutates" /> changes your project; <Badge type="danger" text="destructive" /> can delete, overwrite, run code, or write package assets.`,
    "",
    "> This page is generated from the running tool registry, so it always matches the installed version.",
    "",
  ].join("\n");

  const body = groups.map(renderGroup).join("\n");
  const rendered = `${header}\n${body}`.replace(/\n{3,}/g, "\n\n").trimEnd();
  const outPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "docs",
    "reference",
    "tools.md",
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${rendered}\n`, "utf8");

  console.log(`Wrote ${outPath}`);
  console.log(`Total tools: ${total} (${breakdown})`);
}

main();
