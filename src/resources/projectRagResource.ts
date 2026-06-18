/**
 * Project RAG — read-only MCP resources.
 *
 * Exposes the local project repertoire as read-only resources:
 *   - `tdmcp://project/cards/{id}`     → one card (provenance + license + score)
 *   - `tdmcp://project/search{?q,k,…}` → ranked search results
 *
 * Registered ONLY when `ctx.projectRag` is defined (i.e.
 * `TDMCP_RAG_ENABLED=1 && TDMCP_PROJECT_RAG_ENABLED=1`), so the feature is fully
 * inert when off. These resources NEVER touch the TD bridge, DMX, or Python
 * exec — Project RAG is repertoire context only. Every returned item carries
 * `provenance.sourceUrl` / `license` / `rightsNotes`.
 */

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ProjectRagLicense,
  ProjectRagService,
  ProjectRagType,
  ProjectSearchFilters,
} from "../projectRag/index.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

const VALID_LICENSES: readonly ProjectRagLicense[] = [
  "CC0",
  "PublicDomain",
  "CC-BY",
  "CC-BY-SA",
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "GPL-2.0",
  "GPL-3.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "AGPL-3.0",
  "Derivative-EULA",
  "Proprietary-Free",
  "Proprietary-Paid",
  "Unknown",
  "Restricted",
];
const VALID_TYPES: readonly ProjectRagType[] = [
  "project",
  "component",
  "snippet",
  "tutorial",
  "custom-op",
  "framework",
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

function buildFilters(uri: URL): ProjectSearchFilters | undefined {
  const filters: ProjectSearchFilters = {};
  const license = csv(uri.searchParams.get("license") ?? "").filter((v): v is ProjectRagLicense =>
    (VALID_LICENSES as readonly string[]).includes(v),
  );
  const type = csv(uri.searchParams.get("type") ?? "").filter((v): v is ProjectRagType =>
    (VALID_TYPES as readonly string[]).includes(v),
  );
  const tags = csv(uri.searchParams.get("tags") ?? "");
  const operators = csv(uri.searchParams.get("operator") ?? "");
  if (license.length > 0) filters.license = license;
  if (type.length > 0) filters.type = type;
  if (tags.length > 0) filters.tags = tags;
  if (operators.length > 0) filters.operators = operators;
  return Object.keys(filters).length > 0 ? filters : undefined;
}

function registerCardResource(
  server: Parameters<ResourceRegistrar>[0],
  service: ProjectRagService,
): void {
  const template = new ResourceTemplate("tdmcp://project/cards/{id}", { list: undefined });
  server.registerResource(
    "project-card",
    template,
    {
      title: "Project RAG card",
      description:
        "One local TouchDesigner project/component card by id (sha256 of provenance.canonical). Read-only; always includes provenance + license + rightsNotes. Absent (404-style payload) for missing or tombstoned cards.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = firstVar(variables.id);
      const card = await service.getCard(id);
      if (card === undefined) return jsonContents(uri, { error: `Card "${id}" not found.` });
      return jsonContents(uri, card);
    },
  );
}

function registerSearchResource(
  server: Parameters<ResourceRegistrar>[0],
  service: ProjectRagService,
): void {
  const template = new ResourceTemplate("tdmcp://project/search{?q,k,license,type,tags,operator}", {
    list: undefined,
  });
  server.registerResource(
    "project-search",
    template,
    {
      title: "Project RAG search",
      description:
        "Cosine search over the local project repertoire index. Query params: q (required), k, license, type, tags (CSV), operator (CSV of TD op type names). Read-only; every result includes provenance + license + rightsNotes.",
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
 * Registers the read-only Project RAG resources. No-op unless `ctx.projectRag`
 * is defined, so the feature stays fully inert when either gating flag is off.
 */
export const registerProjectRagResource: ResourceRegistrar = (server, ctx) => {
  const service = ctx.projectRag;
  if (service === undefined) return;
  registerCardResource(server, service);
  registerSearchResource(server, service);
};
