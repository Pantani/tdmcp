/**
 * Creative RAG — read-only MCP resources.
 *
 * Exposes the local repertoire as two read-only resources:
 *   - `tdmcp://creative/cards/{id}`  → one card (rights always included)
 *   - `tdmcp://creative/search{?q,k,license,type,tags}` → ranked search results
 *
 * Registered ONLY when `ctx.creativeRag` is defined (i.e. `TDMCP_RAG_ENABLED=1`),
 * so the feature is fully inert when off. These resources never touch the TD
 * bridge, DMX, or Python exec — Creative RAG is repertoire context only. Every
 * returned item carries `sourceUrl` / `license` / `rightsNotes`.
 */

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CreativeRagLicense,
  CreativeRagService,
  CreativeRagType,
  SearchFilters,
} from "../creativeRag/index.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

const VALID_LICENSES: readonly CreativeRagLicense[] = [
  "CC0",
  "PublicDomain",
  "CC-BY",
  "CC-BY-SA",
  "Unknown",
  "Restricted",
];
const VALID_TYPES: readonly CreativeRagType[] = [
  "project",
  "artist",
  "artwork",
  "technique",
  "cue_reference",
];

const DEFAULT_K = 10;
const MAX_K = 50;

function csv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseK(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_K;
  return Math.min(parsed, MAX_K);
}

function buildFilters(uri: URL): SearchFilters | undefined {
  const filters: SearchFilters = {};
  const license = csv(uri.searchParams.get("license") ?? "").filter((v): v is CreativeRagLicense =>
    (VALID_LICENSES as readonly string[]).includes(v),
  );
  const type = csv(uri.searchParams.get("type") ?? "").filter((v): v is CreativeRagType =>
    (VALID_TYPES as readonly string[]).includes(v),
  );
  const tags = csv(uri.searchParams.get("tags") ?? "");
  if (license.length > 0) filters.license = license;
  if (type.length > 0) filters.type = type;
  if (tags.length > 0) filters.tags = tags;
  return Object.keys(filters).length > 0 ? filters : undefined;
}

function registerCardResource(
  server: Parameters<ResourceRegistrar>[0],
  service: CreativeRagService,
): void {
  const template = new ResourceTemplate("tdmcp://creative/cards/{id}", { list: undefined });
  server.registerResource(
    "creative-card",
    template,
    {
      title: "Creative RAG card",
      description:
        "One local repertoire card by id (sha256 of its source URL). Read-only; always includes sourceUrl / license / rightsNotes. Absent (404-style payload) for missing or tombstoned cards.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = firstVar(variables.id);
      const card = await service.getCard(id);
      if (card === undefined) {
        return jsonContents(uri, { error: `Card "${id}" not found.` });
      }
      return jsonContents(uri, card);
    },
  );
}

function registerSearchResource(
  server: Parameters<ResourceRegistrar>[0],
  service: CreativeRagService,
): void {
  const template = new ResourceTemplate("tdmcp://creative/search{?q,k,license,type,tags}", {
    list: undefined,
  });
  server.registerResource(
    "creative-search",
    template,
    {
      title: "Creative RAG search",
      description:
        "Cosine search over the local repertoire index. Query params: q (required), k, license, type, tags (CSV). Read-only; every result includes sourceUrl / license / rightsNotes.",
      mimeType: "application/json",
    },
    async (uri) => {
      const query = (uri.searchParams.get("q") ?? "").trim();
      if (query.length === 0) {
        return jsonContents(uri, { error: 'Search needs a "q" query parameter.', results: [] });
      }
      const k = parseK(uri.searchParams.get("k") ?? "");
      const filters = buildFilters(uri);
      const results = await service.search(query, k, filters);
      return jsonContents(uri, { query, count: results.length, results });
    },
  );
}

/**
 * Registers the read-only Creative RAG resources. No-op unless `ctx.creativeRag`
 * is defined, so the feature stays fully inert when `TDMCP_RAG_ENABLED` is off.
 */
export const registerCreativeRagResource: ResourceRegistrar = (server, ctx) => {
  const service = ctx.creativeRag;
  if (service === undefined) return;
  registerCardResource(server, service);
  registerSearchResource(server, service);
};
