/**
 * Project RAG — read-only `tdmcp://project/sources` resource.
 *
 * Sibling of `tdmcp://project/cards/{id}` and `tdmcp://project/search`: exposes
 * the configured Project RAG sources + their current status (`ready`,
 * `skipped`, `planned`, `failed`) so the agent can tell which sources are
 * indexed vs absent before issuing a search. Registered ONLY when
 * `ctx.projectRag` is defined (gated by
 * `TDMCP_RAG_ENABLED=1 && TDMCP_PROJECT_RAG_ENABLED=1`).
 */

import { jsonContents, type ResourceRegistrar } from "./shared.js";

export const registerProjectRagSourcesResource: ResourceRegistrar = (server, ctx) => {
  const service = ctx.projectRag;
  if (service === undefined) return;
  server.registerResource(
    "project-sources",
    "tdmcp://project/sources",
    {
      title: "Project RAG sources",
      description:
        "Lists configured Project RAG sources and their status (ready / skipped / planned / failed) so the agent can tell which sources are indexed vs absent.",
      mimeType: "application/json",
    },
    async (uri) => {
      const sources = await service.listSources();
      return jsonContents(uri, { sources });
    },
  );
};
