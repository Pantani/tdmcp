import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export type CookbookLocale = "en" | "pt";

export interface CookbookPayload {
  locale: CookbookLocale;
  title: string;
  source: string;
  bytes: number;
  text: string;
  error?: string;
}

function cookbookPath(locale: CookbookLocale): string {
  const relative =
    locale === "pt" ? "docs/pt/guide/prompt-cookbook.md" : "docs/guide/prompt-cookbook.md";
  const candidates = [
    resolve(moduleDir, "../../", relative),
    resolve(moduleDir, "../", relative),
    resolve(process.cwd(), relative),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? relative;
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
