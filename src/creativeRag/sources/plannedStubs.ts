/**
 * Creative RAG — planned source stubs.
 *
 * Six further sources are scoped but NOT implemented. They ship as
 * documented stubs (`status: "planned"` + an explicit reason) so the build team
 * and users know why each is deferred. None are wired into `sync`. The list
 * mirrors the "Planned sources (stubs)" table in `docs/CREATIVE_RAG.md`.
 */

import type { PlannedSourceStub } from "../types.js";

export const PLANNED_SOURCE_STUBS: PlannedSourceStub[] = [
  {
    name: "harvard",
    displayName: "Harvard Art Museums",
    status: "planned",
    reason: "Requires an API key (auth).",
  },
  {
    name: "cooperhewitt",
    displayName: "Cooper Hewitt",
    status: "planned",
    reason: "Requires an API key (auth).",
  },
  {
    name: "internetarchive",
    displayName: "Internet Archive",
    status: "planned",
    reason:
      "Mixed/unclear licensing per item (ambiguous license); needs scraping of rights metadata.",
  },
  {
    name: "wikiart",
    displayName: "WikiArt",
    status: "planned",
    reason: "No official open API; would require scraping and licenses are restricted.",
  },
  {
    name: "portfolios",
    displayName: "Behance / Vimeo / artist portfolios",
    status: "planned",
    reason: "No open license; copyrighted (restricted) — reference-only, never ingest binaries.",
  },
  {
    name: "shadertoy",
    displayName: "Shadertoy",
    status: "planned",
    reason:
      "Per-shader licensing varies and often unspecified (ambiguous license); covered better by tdmcp's existing ISF/Shadertoy import tools.",
  },
];
