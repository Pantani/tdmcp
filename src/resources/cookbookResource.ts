import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const MAX_PACKAGE_SEARCH_DEPTH = 8;

export type CookbookLocale = "en" | "pt";

export interface CookbookPayload {
  locale: CookbookLocale;
  title: string;
  source: string;
  bytes: number;
  text: string;
  error?: string;
}

function cookbookRelativePath(locale: CookbookLocale): string {
  return locale === "pt" ? "docs/pt/guide/prompt-cookbook.md" : "docs/guide/prompt-cookbook.md";
}

function packageRootFromModuleDir(startDir: string): string | undefined {
  let current = resolve(startDir);
  for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth += 1) {
    if (existsSync(resolve(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function cookbookPathFromModuleDir(locale: CookbookLocale, startDir: string): string {
  const relative = cookbookRelativePath(locale);
  const packageRoot = packageRootFromModuleDir(startDir);
  const candidates = [
    ...(packageRoot ? [resolve(packageRoot, relative)] : []),
    resolve(startDir, "../../", relative),
    resolve(startDir, "../", relative),
    resolve(process.cwd(), relative),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? relative;
}

function cookbookPath(locale: CookbookLocale): string {
  return cookbookPathFromModuleDir(locale, moduleDir);
}

function firstHeading(markdown: string, fallback: string): string {
  return (
    markdown
      .split(/\r?\n/)
      .find((line) => line.startsWith("# "))
      ?.replace(/^#\s+/, "")
      .trim() ?? fallback
  );
}

function fallbackTitle(locale: CookbookLocale): string {
  return locale === "pt" ? "Livro de Receitas de Prompts" : "Prompt Cookbook";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readCookbookResourceFromPath(
  locale: CookbookLocale,
  source: string,
): CookbookPayload {
  let text: string;
  try {
    text = readFileSync(source, "utf8");
  } catch (error) {
    return {
      locale,
      title: fallbackTitle(locale),
      source,
      bytes: 0,
      text: "",
      error: `Could not read prompt cookbook from ${source}: ${errorMessage(error)}`,
    };
  }

  return {
    locale,
    title: firstHeading(text, fallbackTitle(locale)),
    source,
    bytes: Buffer.byteLength(text, "utf8"),
    text,
  };
}

export function readCookbookResource(locale: CookbookLocale = "en"): CookbookPayload {
  return readCookbookResourceFromPath(locale, cookbookPath(locale));
}

export const registerCookbookResource: ResourceRegistrar = (server) => {
  server.registerResource(
    "td-cookbook",
    "tdmcp://cookbook",
    {
      title: "Prompt cookbook",
      description:
        "The English prompt cookbook as Markdown, exposed as a resource for agents that want worked examples before building.",
      mimeType: "application/json",
    },
    async (uri) => jsonContents(uri, readCookbookResource("en")),
  );

  const localized = new ResourceTemplate("tdmcp://cookbook/{locale}", {
    list: async () => ({
      resources: [
        {
          uri: "tdmcp://cookbook/en",
          name: "Prompt cookbook (English)",
          mimeType: "application/json",
        },
        {
          uri: "tdmcp://cookbook/pt",
          name: "Prompt cookbook (Portuguese)",
          mimeType: "application/json",
        },
      ],
    }),
  });

  server.registerResource(
    "td-cookbook-localized",
    localized,
    {
      title: "Localized prompt cookbook",
      description: "Read the prompt cookbook in English (`en`) or Portuguese (`pt`).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const raw = firstVar(variables.locale).toLowerCase();
      const locale: CookbookLocale = raw === "pt" ? "pt" : "en";
      return jsonContents(uri, readCookbookResource(locale));
    },
  );
};
